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
        client.getBodyBatteryDaily(date),
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

      return {
        latestRun,
        recovery: {
          summary: settled(results[1]),
          sleep: settled(results[2]),
          hrv: settled(results[3]),
          bodyBattery: settled(results[4]),
          trainingReadiness: settled(results[5]),
          trainingStatus: settled(results[6]),
          vo2Max: settled(results[7]),
        },
      };
    });

    return json({
      date,
      privacy: {
        activityGpsIncluded: false,
        profileIncluded: false,
        userRolesIncluded: false,
      },
      ...data,
    });
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
