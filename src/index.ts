import {
  GarminApiError,
  GarminAuthError,
  GarminConnectClient,
  GarminMfaRequiredError,
  GarminRateLimitError,
} from "@dofek/garmin-connect";
import type { GarminTokens } from "@dofek/garmin-connect/types";

interface Env {
  GARMIN_KV: KVNamespace;
  API_TOKEN: string;
  ADMIN_TOKEN: string;
  TIMEZONE?: string;
}

const TOKEN_KEY = "garmin:tokens";

// Cloudflare Workers native fetch must be invoked with the correct receiver.
// Wrapping it prevents "Illegal invocation" when a library stores fetch as a method.
const cfFetch: typeof globalThis.fetch = (input, init) =>
  globalThis.fetch(input, init);

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

function isAuthorized(request: Request, expected: string | undefined): boolean {
  if (!expected) return false;
  return bearerToken(request) === expected;
}

function todayInTimezone(timezone = "UTC"): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const values = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function getDate(url: URL, env: Env): string {
  return url.searchParams.get("date") || todayInTimezone(env.TIMEZONE || "UTC");
}

function round(value: unknown, digits = 0): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function compactRun(activity: any): Record<string, unknown> | null {
  if (!activity) return null;

  const distanceMeters =
    typeof activity.distance === "number" ? activity.distance : null;
  const durationSeconds =
    typeof activity.duration === "number" ? activity.duration : null;

  const paceSecPerKm =
    distanceMeters && durationSeconds
      ? durationSeconds / (distanceMeters / 1000)
      : null;

  return {
    id: activity.activityId ?? null,
    name: activity.activityName ?? null,
    activityType: activity.activityType?.typeKey ?? null,
    startTimeLocal: activity.startTimeLocal ?? null,

    distanceKm: distanceMeters ? round(distanceMeters / 1000, 2) : null,
    durationSeconds: durationSeconds ? round(durationSeconds, 1) : null,
    movingDurationSeconds:
      typeof activity.movingDuration === "number"
        ? round(activity.movingDuration, 1)
        : null,
    paceSecPerKm: paceSecPerKm ? round(paceSecPerKm, 1) : null,

    elevationGainM: round(activity.elevationGain, 0),
    elevationLossM: round(activity.elevationLoss, 0),

    calories: round(activity.calories, 0),

    avgHr: round(activity.averageHR, 0),
    maxHr: round(activity.maxHR, 0),

    avgCadenceSpm: round(
      activity.averageRunningCadenceInStepsPerMinute,
      1,
    ),
    maxCadenceSpm: round(
      activity.maxRunningCadenceInStepsPerMinute,
      0,
    ),

    avgPowerW: round(activity.avgPower, 0),
    maxPowerW: round(activity.maxPower, 0),
    normalizedPowerW: round(activity.normPower, 0),

    vo2Max: round(activity.vO2MaxValue, 1),

    aerobicTrainingEffect: round(activity.aerobicTrainingEffect, 1),
    anaerobicTrainingEffect: round(activity.anaerobicTrainingEffect, 1),
    trainingEffectLabel: activity.trainingEffectLabel ?? null,
    trainingLoad: round(activity.activityTrainingLoad, 1),

    bodyBatteryImpact: round(activity.differenceBodyBattery, 0),

    runningDynamics: {
      verticalOscillationCm: round(activity.avgVerticalOscillation, 2),
      groundContactTimeMs: round(activity.avgGroundContactTime, 1),
      strideLengthCm: round(activity.avgStrideLength, 1),
      verticalRatioPercent: round(activity.avgVerticalRatio, 2),
    },

    fastestSplitsSeconds: {
      m1000: round(activity.fastestSplit_1000, 1),
      mile1609: round(activity.fastestSplit_1609, 1),
      m5000: round(activity.fastestSplit_5000, 1),
    },

    hrZonesSeconds: {
      z1: round(activity.hrTimeInZone_1, 1),
      z2: round(activity.hrTimeInZone_2, 1),
      z3: round(activity.hrTimeInZone_3, 1),
      z4: round(activity.hrTimeInZone_4, 1),
      z5: round(activity.hrTimeInZone_5, 1),
    },

    powerZonesSeconds: {
      z1: round(activity.powerTimeInZone_1, 1),
      z2: round(activity.powerTimeInZone_2, 1),
      z3: round(activity.powerTimeInZone_3, 1),
      z4: round(activity.powerTimeInZone_4, 1),
      z5: round(activity.powerTimeInZone_5, 1),
    },
  };
}


function compactDailySummary(summary: any): Record<string, unknown> | { error: string } | null {
  if (!summary) return null;
  if (summary.error) return summary;

  return {
    steps: summary.totalSteps ?? null,
    distanceMeters: summary.totalDistanceMeters ?? null,
    activeKilocalories: summary.activeKilocalories ?? null,
    restingHeartRate: summary.restingHeartRate ?? null,
    sevenDayAvgRestingHeartRate: summary.lastSevenDaysAvgRestingHeartRate ?? null,
    averageStress: summary.averageStressLevel ?? null,
    maxStress: summary.maxStressLevel ?? null,
    intensityMinutes: {
      moderate: summary.moderateIntensityMinutes ?? null,
      vigorous: summary.vigorousIntensityMinutes ?? null,
    },
    bodyBattery: {
      atWake: summary.bodyBatteryAtWakeTime ?? null,
      current: summary.bodyBatteryMostRecentValue ?? null,
      highest: summary.bodyBatteryHighestValue ?? null,
      lowest: summary.bodyBatteryLowestValue ?? null,
      charged: summary.bodyBatteryChargedValue ?? null,
      drained: summary.bodyBatteryDrainedValue ?? null,
      duringSleep: summary.bodyBatteryDuringSleep ?? null,
    },
    spo2: {
      average: summary.averageSpo2 ?? null,
      lowest: summary.lowestSpo2 ?? null,
      latest: summary.latestSpo2 ?? null,
    },
    respiration: {
      wakingAverage: summary.avgWakingRespirationValue ?? null,
      highest: summary.highestRespirationValue ?? null,
      lowest: summary.lowestRespirationValue ?? null,
      latest: summary.latestRespirationValue ?? null,
    },
  };
}

function compactSleep(sleep: any): Record<string, unknown> | { error: string } | null {
  if (!sleep) return null;
  if (sleep.error) return sleep;

  const d = sleep.dailySleepDTO ?? {};
  const scores = d.sleepScores ?? {};

  return {
    durationSeconds: d.sleepTimeSeconds ?? null,
    napSeconds: d.napTimeSeconds ?? null,
    deepSeconds: d.deepSleepSeconds ?? null,
    lightSeconds: d.lightSleepSeconds ?? null,
    remSeconds: d.remSleepSeconds ?? null,
    awakeSeconds: d.awakeSleepSeconds ?? null,
    awakenings: d.awakeCount ?? null,
    restlessMoments: sleep.restlessMomentsCount ?? null,
    sleepScore: scores.overall?.value ?? null,
    sleepScoreQualifier: scores.overall?.qualifierKey ?? null,
    avgSleepStress: d.avgSleepStress ?? null,
    avgHeartRate: d.avgHeartRate ?? null,
    avgSpO2: d.averageSpO2Value ?? null,
    lowestSpO2: d.lowestSpO2Value ?? null,
    avgRespiration: d.averageRespirationValue ?? null,
    breathingDisruptionSeverity: d.breathingDisruptionSeverity ?? null,
    sleepNeedMinutes: d.sleepNeed?.actual ?? null,
    nextSleepNeedMinutes: d.nextSleepNeed?.actual ?? null,
  };
}

function compactHrv(hrv: any): Record<string, unknown> | { error: string } | null {
  if (!hrv) return null;
  if (hrv.error) return hrv;

  const s = hrv.hrvSummary ?? {};

  return {
    status: s.status ?? null,
    lastNightAvg: s.lastNightAvg ?? null,
    weeklyAvg: s.weeklyAvg ?? null,
    lastNight5MinHigh: s.lastNight5MinHigh ?? null,
    baseline: {
      lowUpper: s.baseline?.lowUpper ?? null,
      balancedLow: s.baseline?.balancedLow ?? null,
      balancedUpper: s.baseline?.balancedUpper ?? null,
    },
  };
}

function compactTrainingReadiness(readiness: any): Record<string, unknown> | { error: string } | null {
  if (!readiness) return null;
  if (readiness.error) return readiness;

  const r = Array.isArray(readiness) ? readiness[0] : readiness;
  if (!r) return null;

  return {
    score: r.score ?? null,
    level: r.level ?? null,
    feedback: r.feedbackShort ?? null,
    recoveryTimeMinutes: r.recoveryTime ?? null,
    acuteLoad: r.acuteLoad ?? null,
    hrvWeeklyAverage: r.hrvWeeklyAverage ?? null,
    factors: {
      sleep: r.sleepScoreFactorFeedback ?? null,
      recoveryTime: r.recoveryTimeFactorFeedback ?? null,
      acuteChronicWorkload: r.acwrFactorFeedback ?? null,
      stressHistory: r.stressHistoryFactorFeedback ?? null,
      hrv: r.hrvFactorFeedback ?? null,
      sleepHistory: r.sleepHistoryFactorFeedback ?? null,
    },
    context: r.inputContext ?? null,
  };
}

function compactTrainingStatus(status: any): Record<string, unknown> | { error: string } | null {
  if (!status) return null;
  if (status.error) return status;

  const latestMap = status.mostRecentTrainingStatus?.latestTrainingStatusData ?? {};
  const latest = Object.values(latestMap)[0] as any;

  const balanceMap =
    status.mostRecentTrainingLoadBalance?.metricsTrainingLoadBalanceDTOMap ?? {};
  const balance = Object.values(balanceMap)[0] as any;

  return {
    statusCode: latest?.trainingStatus ?? null,
    feedback: latest?.trainingStatusFeedbackPhrase ?? null,
    fitnessTrend: latest?.fitnessTrend ?? null,
    sport: latest?.sport ?? null,
    acuteLoad: {
      value: latest?.acuteTrainingLoadDTO?.dailyTrainingLoadAcute ?? null,
      chronic: latest?.acuteTrainingLoadDTO?.dailyTrainingLoadChronic ?? null,
      ratio: latest?.acuteTrainingLoadDTO?.dailyAcuteChronicWorkloadRatio ?? null,
      status: latest?.acuteTrainingLoadDTO?.acwrStatus ?? null,
    },
    loadBalance: {
      aerobicLow: balance?.monthlyLoadAerobicLow ?? null,
      aerobicHigh: balance?.monthlyLoadAerobicHigh ?? null,
      anaerobic: balance?.monthlyLoadAnaerobic ?? null,
      feedback: balance?.trainingBalanceFeedbackPhrase ?? null,
    },
  };
}

function compactVo2Max(vo2: any): Record<string, unknown> | { error: string } | null {
  if (!vo2) return null;
  if (vo2.error) return vo2;

  const v = Array.isArray(vo2) ? vo2[0] : vo2;
  const generic = v?.generic ?? null;

  return {
    value: generic?.vo2MaxValue ?? null,
    precise: generic?.vo2MaxPreciseValue ?? null,
  };
}


function shiftIsoDate(date: string, deltaDays: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + deltaDays));
  return shifted.toISOString().slice(0, 10);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compactRunHistoryItem(activity: any): Record<string, unknown> {
  const compact = compactRun(activity) as any;

  return {
    id: compact?.id ?? null,
    startTimeLocal: compact?.startTimeLocal ?? null,
    distanceKm: compact?.distanceKm ?? null,
    durationSeconds: compact?.durationSeconds ?? null,
    paceSecPerKm: compact?.paceSecPerKm ?? null,
    avgHr: compact?.avgHr ?? null,
    maxHr: compact?.maxHr ?? null,
    avgPowerW: compact?.avgPowerW ?? null,
    avgCadenceSpm: compact?.avgCadenceSpm ?? null,
    aerobicTrainingEffect: compact?.aerobicTrainingEffect ?? null,
    anaerobicTrainingEffect: compact?.anaerobicTrainingEffect ?? null,
    trainingLoad: compact?.trainingLoad ?? null,
    vo2Max: compact?.vo2Max ?? null,
  };
}

function summarizeRunsForDate(
  activities: any[],
  date: string,
): Record<string, unknown> {
  const runs = activities.filter((activity: any) => {
    const isRun =
      activity?.activityType?.typeKey === "running" ||
      activity?.sportTypeId === 1;

    const activityDate =
      typeof activity?.startTimeLocal === "string"
        ? activity.startTimeLocal.slice(0, 10)
        : null;

    return isRun && activityDate === date;
  });

  const items = runs.map(compactRunHistoryItem);

  const numericSum = (field: string): number =>
    items.reduce((sum: number, item: any) => {
      const value = item?.[field];
      return sum + (typeof value === "number" ? value : 0);
    }, 0);

  const trainingEffects = items
    .map((item: any) => item?.aerobicTrainingEffect)
    .filter((value: unknown): value is number => typeof value === "number");

  return {
    count: items.length,
    totalDistanceKm: round(numericSum("distanceKm"), 2),
    totalDurationSeconds: round(numericSum("durationSeconds"), 1),
    totalTrainingLoad: round(numericSum("trainingLoad"), 1),
    maxAerobicTrainingEffect:
      trainingEffects.length > 0 ? round(Math.max(...trainingEffects), 1) : null,
    items,
  };
}


function compactTrainingReadinessEntry(r: any): Record<string, unknown> | null {
  if (!r) return null;

  return {
    score: r.score ?? null,
    level: r.level ?? null,
    feedback: r.feedbackShort ?? null,
    recoveryTimeMinutes: r.recoveryTime ?? null,
    acuteLoad: r.acuteLoad ?? null,
    hrvWeeklyAverage: r.hrvWeeklyAverage ?? null,
    factors: {
      sleep: r.sleepScoreFactorFeedback ?? null,
      recoveryTime: r.recoveryTimeFactorFeedback ?? null,
      acuteChronicWorkload: r.acwrFactorFeedback ?? null,
      stressHistory: r.stressHistoryFactorFeedback ?? null,
      hrv: r.hrvFactorFeedback ?? null,
      sleepHistory: r.sleepHistoryFactorFeedback ?? null,
    },
    context: r.inputContext ?? null,
    timestampLocal: r.timestampLocal ?? null,
  };
}

function compactTrainingReadinessHistory(
  readiness: any,
): Record<string, unknown> | { error: string } | null {
  if (!readiness) return null;
  if (readiness.error) return readiness;

  const entries = Array.isArray(readiness) ? readiness : [readiness];
  if (entries.length === 0) return null;

  const sorted = [...entries].sort((a: any, b: any) => {
    const aTime = Date.parse(a?.timestamp ?? a?.timestampLocal ?? "") || 0;
    const bTime = Date.parse(b?.timestamp ?? b?.timestampLocal ?? "") || 0;
    return bTime - aTime;
  });

  const morningRaw =
    sorted.find(
      (entry: any) => entry?.inputContext === "AFTER_WAKEUP_RESET",
    ) ?? null;

  const latestRaw = sorted[0] ?? null;

  return {
    morning: compactTrainingReadinessEntry(morningRaw),
    latest: compactTrainingReadinessEntry(latestRaw),
  };
}

function numericValues(values: unknown[]): number[] {
  return values.filter(
    (value: unknown): value is number =>
      typeof value === "number" && Number.isFinite(value),
  );
}

function average(values: unknown[], digits = 1): number | null {
  const numbers = numericValues(values);
  if (numbers.length === 0) return null;
  return round(
    numbers.reduce((sum, value) => sum + value, 0) / numbers.length,
    digits,
  );
}

function buildCoachTrends(history: Array<Record<string, unknown>>): Record<string, unknown> {
  const days = history as any[];

  const runCount = days.reduce(
    (sum: number, day: any) => sum + (day?.runs?.count ?? 0),
    0,
  );

  const weeklyDistanceKm = days.reduce(
    (sum: number, day: any) => sum + (day?.runs?.totalDistanceKm ?? 0),
    0,
  );

  const weeklyTrainingLoad = days.reduce(
    (sum: number, day: any) => sum + (day?.runs?.totalTrainingLoad ?? 0),
    0,
  );

  const sleepSeconds = days.map(
    (day: any) => day?.recovery?.sleep?.durationSeconds,
  );

  const sleepScores = days.map(
    (day: any) => day?.recovery?.sleep?.sleepScore,
  );

  const hrvValues = days.map(
    (day: any) => day?.recovery?.hrv?.lastNightAvg,
  );

  const restingHrValues = days.map(
    (day: any) => day?.recovery?.daily?.restingHeartRate,
  );

  const bodyBatteryWakeValues = days.map(
    (day: any) => day?.recovery?.daily?.bodyBattery?.atWake,
  );

  const morningReadinessValues = days.map(
    (day: any) => day?.recovery?.trainingReadiness?.morning?.score,
  );

  const latestReadinessValues = days.map(
    (day: any) => day?.recovery?.trainingReadiness?.latest?.score,
  );

  const avgSleepSeconds = average(sleepSeconds, 0);

  return {
    runCount,
    weeklyDistanceKm: round(weeklyDistanceKm, 2),
    weeklyTrainingLoad: round(weeklyTrainingLoad, 1),

    avgSleepHours:
      typeof avgSleepSeconds === "number"
        ? round(avgSleepSeconds / 3600, 2)
        : null,
    avgSleepScore: average(sleepScores, 1),

    avgHrvLastNight: average(hrvValues, 1),
    avgRestingHeartRate: average(restingHrValues, 1),
    avgBodyBatteryAtWake: average(bodyBatteryWakeValues, 1),

    avgMorningTrainingReadiness: average(morningReadinessValues, 1),
    avgLatestTrainingReadiness: average(latestReadinessValues, 1),

    dataCompleteness: {
      days: days.length,
      sleepDays: numericValues(sleepSeconds).length,
      hrvDays: numericValues(hrvValues).length,
      restingHrDays: numericValues(restingHrValues).length,
      bodyBatteryWakeDays: numericValues(bodyBatteryWakeValues).length,
      morningReadinessDays: numericValues(morningReadinessValues).length,
    },
  };
}

function compactHistoryRecovery(
  summary: unknown,
  sleep: unknown,
  hrv: unknown,
  readiness: unknown,
): Record<string, unknown> {
  const daily = compactDailySummary(summary);
  const compactedSleep = compactSleep(sleep);
  const compactedHrv = compactHrv(hrv);
  const compactedReadiness = compactTrainingReadinessHistory(readiness);

  return {
    daily,
    sleep: compactedSleep,
    hrv: compactedHrv,
    trainingReadiness: compactedReadiness,
  };
}


type RunningWorkoutStepInput = {
  type: "warmup" | "interval" | "recovery" | "cooldown";
  durationSeconds: number;
  description?: string;
};

type RunningWorkoutInput = {
  name: string;
  description?: string;
  date?: string;
  steps: RunningWorkoutStepInput[];
};

function parseRunningWorkoutInput(value: unknown): RunningWorkoutInput {
  if (!value || typeof value !== "object") {
    throw new Error("Workout body must be a JSON object");
  }

  const raw = value as Record<string, unknown>;

  if (typeof raw.name !== "string" || raw.name.trim().length < 1) {
    throw new Error("Workout name is required");
  }

  if (!Array.isArray(raw.steps) || raw.steps.length < 1) {
    throw new Error("Workout must contain at least one step");
  }

  const allowedTypes = new Set(["warmup", "interval", "recovery", "cooldown"]);

  const steps = raw.steps.map((step, index) => {
    if (!step || typeof step !== "object") {
      throw new Error(`Step ${index + 1} must be an object`);
    }

    const s = step as Record<string, unknown>;

    if (typeof s.type !== "string" || !allowedTypes.has(s.type)) {
      throw new Error(
        `Step ${index + 1} type must be warmup, interval, recovery, or cooldown`,
      );
    }

    if (
      typeof s.durationSeconds !== "number" ||
      !Number.isFinite(s.durationSeconds) ||
      s.durationSeconds <= 0 ||
      s.durationSeconds > 6 * 60 * 60
    ) {
      throw new Error(`Step ${index + 1} has invalid durationSeconds`);
    }

    return {
      type: s.type as RunningWorkoutStepInput["type"],
      durationSeconds: Math.round(s.durationSeconds),
      ...(typeof s.description === "string" && s.description.trim()
        ? { description: s.description.trim().slice(0, 500) }
        : {}),
    };
  });

  const date =
    typeof raw.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.date)
      ? raw.date
      : undefined;

  return {
    name: raw.name.trim().slice(0, 100),
    ...(typeof raw.description === "string" && raw.description.trim()
      ? { description: raw.description.trim().slice(0, 1000) }
      : {}),
    ...(date ? { date } : {}),
    steps,
  };
}

function buildGarminRunningWorkout(input: RunningWorkoutInput): Record<string, unknown> {
  const sportType = { sportTypeId: 1, sportTypeKey: "running" };

  const stepTypes = {
    warmup: { stepTypeId: 1, stepTypeKey: "warmup" },
    cooldown: { stepTypeId: 2, stepTypeKey: "cooldown" },
    interval: { stepTypeId: 3, stepTypeKey: "interval" },
    recovery: { stepTypeId: 4, stepTypeKey: "recovery" },
  } as const;

  const workoutSteps = input.steps.map((step, index) => ({
    type: "ExecutableStepDTO",
    stepOrder: index + 1,
    stepType: stepTypes[step.type],
    endCondition: {
      conditionTypeId: 2,
      conditionTypeKey: "time",
    },
    endConditionValue: step.durationSeconds,
    targetType: {
      workoutTargetTypeId: 1,
      workoutTargetTypeKey: "no.target",
    },
    ...(step.description ? { description: step.description } : {}),
  }));

  const estimatedDurationInSecs = input.steps.reduce(
    (sum, step) => sum + step.durationSeconds,
    0,
  );

  return {
    workoutName: input.name,
    ...(input.description ? { description: input.description } : {}),
    sportType,
    estimatedDurationInSecs,
    workoutSegments: [
      {
        segmentOrder: 1,
        sportType,
        workoutSteps,
      },
    ],
  };
}

async function garminWorkoutWrite(
  env: Env,
  client: GarminConnectClient,
  path: string,
  method: "POST" | "DELETE",
  body?: unknown,
): Promise<unknown> {
  const tokens = client.getTokens();
  const accessToken = tokens?.oauth2?.access_token;

  if (!tokens || !accessToken) {
    throw new Error("Garmin OAuth2 token is unavailable");
  }

  const response = await cfFetch(`https://connectapi.garmin.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "GCM-iOS-5.19.1.2",
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const responseText = await response.text();

  if (!response.ok) {
    const safeMessage =
      responseText.length > 1200
        ? `${responseText.slice(0, 1200)}…`
        : responseText;

    throw new Error(
      `Garmin workout API ${method} ${path} failed (${response.status}): ${safeMessage}`,
    );
  }

  await env.GARMIN_KV.put("garmin:tokens", JSON.stringify(tokens));

  if (!responseText) return null;

  try {
    return JSON.parse(responseText);
  } catch {
    return { raw: responseText };
  }
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const parsed = raw ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

async function loadClient(env: Env): Promise<GarminConnectClient> {
  const stored = await env.GARMIN_KV.get<GarminTokens>(TOKEN_KEY, "json");
  if (!stored) {
    throw new GarminAuthError(
      "Garmin is not connected yet. Call POST /admin/login first.",
    );
  }

  const client = await GarminConnectClient.fromTokens(
    stored,
    "garmin.com",
    cfFetch,
  );
  await persistTokens(env, client);
  return client;
}

async function persistTokens(env: Env, client: GarminConnectClient): Promise<void> {
  const tokens = client.getTokens();
  if (tokens) {
    await env.GARMIN_KV.put(TOKEN_KEY, JSON.stringify(tokens));
  }
}

async function withGarmin<T>(
  env: Env,
  fn: (client: GarminConnectClient) => Promise<T>,
): Promise<T> {
  const client = await loadClient(env);
  try {
    return await fn(client);
  } finally {
    await persistTokens(env, client);
  }
}

function settled<T>(r: PromiseSettledResult<T>): T | { error: string } {
  if (r.status === "fulfilled") return r.value;
  const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
  return { error: message };
}

async function handleAdmin(request: Request, env: Env, url: URL): Promise<Response> {
  if (!isAuthorized(request, env.ADMIN_TOKEN)) {
    return json({ error: "Unauthorized" }, 401);
  }

  if (url.pathname === "/admin/status" && request.method === "GET") {
    const stored = await env.GARMIN_KV.get<GarminTokens>(TOKEN_KEY, "json");
    if (!stored) return json({ connected: false });

    return json({
      connected: true,
      displayName: stored.displayName ?? null,
      oauth2ExpiresAt: stored.oauth2?.expires_at ?? null,
    });
  }

  if (url.pathname === "/admin/login" && request.method === "POST") {
    const body = (await request.json()) as { email?: string; password?: string };
    if (!body.email || !body.password) {
      return json({ error: "JSON body must include email and password" }, 400);
    }

    const { client, tokens } = await GarminConnectClient.signIn(
      body.email,
      body.password,
      "garmin.com",
      cfFetch,
    );

    const tokensToStore = client.getTokens() ?? tokens;
    await env.GARMIN_KV.put(TOKEN_KEY, JSON.stringify(tokensToStore));

    return json({
      connected: true,
      displayName: client.getDisplayName(),
      oauth2ExpiresAt: tokensToStore.oauth2.expires_at,
      passwordStored: false,
    });
  }

  if (url.pathname === "/admin/tokens" && request.method === "PUT") {
    const body = (await request.json()) as GarminTokens;
    const client = await GarminConnectClient.fromTokens(
      body,
      "garmin.com",
      cfFetch,
    );

    // Validate that the tokens can actually access Garmin before persisting.
    await client.getUserSettings();
    await persistTokens(env, client);

    return json({
      connected: true,
      displayName: client.getDisplayName(),
      imported: true,
    });
  }

  if (url.pathname === "/admin/session" && request.method === "DELETE") {
    await env.GARMIN_KV.delete(TOKEN_KEY);
    return json({ connected: false, deleted: true });
  }

  return json({ error: "Admin route not found" }, 404);
}

async function handleV1(request: Request, env: Env, url: URL): Promise<Response> {
  if (!isAuthorized(request, env.API_TOKEN)) {
    return json({ error: "Unauthorized" }, 401);
  }

  if (request.method !== "GET") {
    return json({ error: "Method not allowed" }, 405);
  }

  if (url.pathname === "/v1/activities") {
    const start = clampInt(url.searchParams.get("start"), 0, 0, 100000);
    const limit = clampInt(url.searchParams.get("limit"), 10, 1, 100);
    const data = await withGarmin(env, (client) => client.getActivities(start, limit));
    return json({ start, limit, activities: data });
  }

  if (url.pathname === "/v1/activities/latest") {
    const data = await withGarmin(env, (client) => client.getActivities(0, 1));
    return json({ activity: data[0] ?? null });
  }

  if (url.pathname === "/v1/runs/latest") {
    const data = await withGarmin(env, async (client) => {
      const activities = await client.getActivities(0, 20);

      const run =
        activities.find(
          (activity: any) =>
            activity?.activityType?.typeKey === "running" ||
            activity?.sportTypeId === 1,
        ) ?? null;

      return compactRun(run);
    });

    return json({ run: data });
  }

  const activityMatch = url.pathname.match(/^\/v1\/activities\/(\d+)$/);
  if (activityMatch) {
    const activityId = Number(activityMatch[1]);
    const data = await withGarmin(env, (client) => client.getActivityDetail(activityId));
    return json({ activityId, detail: data });
  }

  if (url.pathname === "/v1/summary") {
    const date = getDate(url, env);
    const data = await withGarmin(env, (client) => client.getDailySummary(date));
    return json({ date, summary: data });
  }

  if (url.pathname === "/v1/sleep") {
    const date = getDate(url, env);
    const data = await withGarmin(env, (client) => client.getSleepData(date));
    return json({ date, sleep: data });
  }

  if (url.pathname === "/v1/hrv") {
    const date = getDate(url, env);
    const data = await withGarmin(env, (client) => client.getHrvSummary(date));
    return json({ date, hrv: data });
  }

  if (url.pathname === "/v1/readiness") {
    const date = getDate(url, env);
    const data = await withGarmin(env, (client) => client.getTrainingReadiness(date));
    return json({ date, trainingReadiness: data });
  }

  if (url.pathname === "/v1/body-battery") {
    const date = getDate(url, env);
    const data = await withGarmin(env, (client) => client.getBodyBatteryDaily(date));
    return json({ date, bodyBattery: data });
  }

  if (url.pathname === "/v1/health/today") {
    const date = getDate(url, env);

    const data = await withGarmin(env, async (client) => {
      const results = await Promise.allSettled([
        client.getDailySummary(date),
        client.getSleepData(date),
        client.getHrvSummary(date),
        client.getBodyBatteryDaily(date),
        client.getTrainingReadiness(date),
        client.getTrainingStatus(date),
        client.getVo2Max(date, date),
      ]);

      return {
        summary: settled(results[0]),
        sleep: settled(results[1]),
        hrv: settled(results[2]),
        bodyBattery: settled(results[3]),
        trainingReadiness: settled(results[4]),
        trainingStatus: settled(results[5]),
        vo2Max: settled(results[6]),
      };
    });

    return json({ date, ...data });
  }

  if (url.pathname === "/v1/coach/context") {
    const date = getDate(url, env);

    const data = await withGarmin(env, async (client) => {
      const results = await Promise.allSettled([
        client.getActivities(0, 20),
        client.getDailySummary(date),
        client.getSleepData(date),
        client.getHrvSummary(date),
        client.getTrainingReadiness(date),
        client.getTrainingStatus(date),
        client.getVo2Max(date, date),
      ]);

      const activitiesResult = settled(results[0]);

      let latestRun: Record<string, unknown> | null | { error: string } = null;

      if (Array.isArray(activitiesResult)) {
        const rawRun =
          activitiesResult.find(
            (activity: any) =>
              activity?.activityType?.typeKey === "running" ||
              activity?.sportTypeId === 1,
          ) ?? null;
        latestRun = compactRun(rawRun);
      } else {
        latestRun = activitiesResult;
      }

      const summary = settled(results[1]);
      const sleep = settled(results[2]);
      const hrv = settled(results[3]);
      const readiness = settled(results[4]);
      const trainingStatus = settled(results[5]);
      const vo2Max = settled(results[6]);

      return {
        latestRun,
        recovery: {
          daily: compactDailySummary(summary),
          sleep: compactSleep(sleep),
          hrv: compactHrv(hrv),
          trainingReadiness: compactTrainingReadiness(readiness),
          trainingStatus: compactTrainingStatus(trainingStatus),
          vo2Max: compactVo2Max(vo2Max),
        },
      };
    });

    return json({
      date,
      privacy: {
        activityGpsIncluded: false,
        profileIncluded: false,
        userRolesIncluded: false,
        deviceIdentifiersIncluded: false,
      },
      ...data,
    });
  }


  if (url.pathname === "/v1/coach/history") {
    const endDate = getDate(url, env);

    // Keep one request comfortably below a large first-run Garmin burst.
    // We can extend to 28 days later using scheduled KV precomputation.
    const days = clampInt(url.searchParams.get("days"), 7, 1, 10);
    const startDate = shiftIsoDate(endDate, -(days - 1));

    const result = await withGarmin(env, async (client) => {
      // One activity request for all days. 100 is intentionally generous for
      // a 10-day personal history window and avoids per-day activity calls.
      const activities = await client.getActivities(0, 100);

      const history: Array<Record<string, unknown>> = [];
      let cachedDays = 0;
      let fetchedDays = 0;

      for (let offset = days - 1; offset >= 0; offset--) {
        const date = shiftIsoDate(endDate, -offset);
        const cacheKey = `coach:history:v2:${date}`;

        let recovery =
          await env.GARMIN_KV.get<Record<string, unknown>>(cacheKey, "json");

        if (recovery) {
          cachedDays += 1;
        } else {
          fetchedDays += 1;

          // Fetch one day's recovery signals together.
          const settledResults = await Promise.allSettled([
            client.getDailySummary(date),
            client.getSleepData(date),
            client.getHrvSummary(date),
            client.getTrainingReadiness(date),
          ]);

          recovery = compactHistoryRecovery(
            settled(settledResults[0]),
            settled(settledResults[1]),
            settled(settledResults[2]),
            settled(settledResults[3]),
          );

          // Today's data changes frequently. Past days are effectively stable
          // but can still be corrected after a late Garmin sync.
          const expirationTtl = date === endDate ? 300 : 21600;

          await env.GARMIN_KV.put(cacheKey, JSON.stringify(recovery), {
            expirationTtl,
          });

          // Spread Garmin request bursts across days.
          if (offset > 0) {
            await delay(700);
          }
        }

        history.push({
          date,
          runs: summarizeRunsForDate(activities as any[], date),
          recovery,
        });
      }

      return {
        history,
        trends: buildCoachTrends(history),
        cache: {
          schemaVersion: 2,
          cachedDays,
          fetchedDays,
        },
      };
    });

    return json({
      period: {
        startDate,
        endDate,
        days,
      },
      privacy: {
        activityGpsIncluded: false,
        profileIncluded: false,
        userRolesIncluded: false,
        deviceIdentifiersIncluded: false,
      },
      ...result,
    });
  }


  if (url.pathname === "/admin/workouts/preview" && request.method === "POST") {
    try {
      const input = parseRunningWorkoutInput(await request.json());
      const payload = buildGarminRunningWorkout(input);

      return json({
        valid: true,
        workout: {
          name: input.name,
          date: input.date ?? null,
          estimatedDurationSeconds: input.steps.reduce(
            (sum, step) => sum + step.durationSeconds,
            0,
          ),
          steps: input.steps,
        },
        garminPayload: payload,
      });
    } catch (error) {
      return json(
        {
          valid: false,
          error: error instanceof Error ? error.message : String(error),
        },
        400,
      );
    }
  }

  if (url.pathname === "/admin/workouts/create" && request.method === "POST") {
    try {
      const input = parseRunningWorkoutInput(await request.json());
      const payload = buildGarminRunningWorkout(input);

      const created = await withGarmin(env, async (client) =>
        garminWorkoutWrite(
          env,
          client,
          "/workout-service/workout",
          "POST",
          payload,
        ),
      );

      const createdRecord =
        created && typeof created === "object"
          ? (created as Record<string, unknown>)
          : {};

      return json({
        created: true,
        workoutId: createdRecord.workoutId ?? null,
        workoutName: createdRecord.workoutName ?? input.name,
        estimatedDurationSeconds: input.steps.reduce(
          (sum, step) => sum + step.durationSeconds,
          0,
        ),
      });
    } catch (error) {
      return json(
        {
          created: false,
          error: error instanceof Error ? error.message : String(error),
        },
        502,
      );
    }
  }

  if (
    url.pathname === "/admin/workouts/create-and-schedule" &&
    request.method === "POST"
  ) {
    try {
      const input = parseRunningWorkoutInput(await request.json());

      if (!input.date) {
        return json(
          {
            created: false,
            scheduled: false,
            error: "date is required in YYYY-MM-DD format",
          },
          400,
        );
      }

      const result = await withGarmin(env, async (client) => {
        const payload = buildGarminRunningWorkout(input);

        const created = await garminWorkoutWrite(
          env,
          client,
          "/workout-service/workout",
          "POST",
          payload,
        );

        const createdRecord =
          created && typeof created === "object"
            ? (created as Record<string, unknown>)
            : {};

        const workoutId = Number(createdRecord.workoutId);

        if (!Number.isFinite(workoutId) || workoutId <= 0) {
          throw new Error("Garmin created the workout but did not return a workoutId");
        }

        try {
          const schedule = await garminWorkoutWrite(
            env,
            client,
            `/workout-service/schedule/${workoutId}`,
            "POST",
            { date: input.date },
          );

          const scheduleRecord =
            schedule && typeof schedule === "object"
              ? (schedule as Record<string, unknown>)
              : {};

          return {
            workoutId,
            scheduled: true,
            scheduleId:
              scheduleRecord.workoutScheduleId ??
              scheduleRecord.id ??
              null,
            scheduleError: null,
          };
        } catch (scheduleError) {
          return {
            workoutId,
            scheduled: false,
            scheduleId: null,
            scheduleError:
              scheduleError instanceof Error
                ? scheduleError.message
                : String(scheduleError),
          };
        }
      });

      return json({
        created: true,
        scheduled: result.scheduled,
        date: input.date,
        workoutId: result.workoutId,
        workoutScheduleId: result.scheduleId,
        workoutName: input.name,
        estimatedDurationSeconds: input.steps.reduce(
          (sum, step) => sum + step.durationSeconds,
          0,
        ),
        ...(result.scheduleError
          ? {
              warning:
                `Workout was saved in Garmin Connect but scheduling failed: ${result.scheduleError}`,
            }
          : {}),
      });
    } catch (error) {
      return json(
        {
          created: false,
          scheduled: false,
          error: error instanceof Error ? error.message : String(error),
        },
        502,
      );
    }
  }

  return json({ error: "Route not found" }, 404);
}

function docs(): Response {
  return json({
    service: "garmin-rest-worker",
    version: "0.1.0",
    endpoints: {
      public: ["GET /healthz"],
      admin: [
        "GET /admin/status",
        "POST /admin/workouts/preview",
        "POST /admin/workouts/create",
        "POST /admin/workouts/create-and-schedule",
        "POST /admin/login",
        "PUT /admin/tokens",
        "DELETE /admin/session",
      ],
      api: [
        "GET /v1/activities?start=0&limit=10",
        "GET /v1/activities/latest",
        "GET /v1/runs/latest",
        "GET /v1/activities/:id",
        "GET /v1/summary?date=YYYY-MM-DD",
        "GET /v1/sleep?date=YYYY-MM-DD",
        "GET /v1/hrv?date=YYYY-MM-DD",
        "GET /v1/readiness?date=YYYY-MM-DD",
        "GET /v1/body-battery?date=YYYY-MM-DD",
        "GET /v1/health/today",
        "GET /v1/coach/context",
        "GET /v1/coach/history?days=7",
      ],
    },
  });
}

function mapError(error: unknown): Response {
  if (error instanceof GarminMfaRequiredError) {
    return json(
      {
        error: "Garmin MFA is required",
        code: "GARMIN_MFA_REQUIRED",
        message:
          "The current V1 login client cannot complete Garmin MFA. Use token import or upgrade the auth flow.",
      },
      409,
    );
  }

  if (error instanceof GarminRateLimitError) {
    return json(
      {
        error: "Garmin rate limit",
        code: "GARMIN_RATE_LIMIT",
        retryAfterSeconds: error.retryAfterSeconds ?? null,
      },
      429,
    );
  }

  if (error instanceof GarminAuthError) {
    return json({ error: error.message, code: "GARMIN_AUTH_ERROR" }, 401);
  }

  if (error instanceof GarminApiError) {
    return json(
      {
        error: error.message,
        code: "GARMIN_API_ERROR",
        statusCode: error.statusCode,
      },
      error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 502,
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  return json({ error: message, code: "INTERNAL_ERROR" }, 500);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/" && request.method === "GET") {
        return docs();
      }

      if (url.pathname === "/healthz" && request.method === "GET") {
        return json({ ok: true, time: new Date().toISOString() });
      }

      if (url.pathname.startsWith("/admin/")) {
        return await handleAdmin(request, env, url);
      }

      if (url.pathname.startsWith("/v1/")) {
        return await handleV1(request, env, url);
      }

      return json({ error: "Not found" }, 404);
    } catch (error) {
      return mapError(error);
    }
  },
} satisfies ExportedHandler<Env>;
