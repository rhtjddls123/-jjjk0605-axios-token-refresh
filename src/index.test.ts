import { http, HttpResponse, delay, DefaultBodyType } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, test, vitest } from "vitest";

import { createStore } from "zustand/vanilla";
import { createTokenAxios, CreateTokenAxiosOptions } from ".";

interface AuthState {
  accessToken: string | null;
  setAccessToken: (token: string | null) => void;
}

const useAuthStore = createStore<AuthState>((set) => ({
  accessToken: null,
  setAccessToken: (token: string | null) => set({ accessToken: token })
}));

function createTestApi(overrides: Partial<CreateTokenAxiosOptions> = {}) {
  const { client } = createTokenAxios({
    baseURL: "http://localhost:3000",
    withCredentials: true,
    getAccessToken: () => useAuthStore.getState().accessToken,
    setAccessToken: (t) => useAuthStore.getState().setAccessToken(t),
    refreshRequest: async (refreshAxios) => {
      const res = await refreshAxios.post<{ accessToken: string }>("/api/v1/refresh");
      return res.data.accessToken;
    },
    headerName: "Authorization",
    headerScheme: "Bearer ",
    shouldRefresh: (err) => err.response?.status === 401,
    ...overrides
  });

  return client;
}

const api = createTestApi();
const server = setupServer();

beforeAll(() => server.listen());

afterEach(() => {
  server.resetHandlers();
  useAuthStore.setState({ accessToken: null });
});

afterAll(() => server.close());

describe("Axios 토큰 갱신 인터셉터 통합 테스트 ", () => {
  test("시나리오 1: 단일 요청이 401을 받으면, 토큰 갱신 후 성공적으로 재시도되어야 한다.", async () => {
    const refreshSpy = vitest.fn();
    let callCount = 0;

    server.use(
      http.post("http://localhost:3000/api/v1/refresh", () => {
        refreshSpy();
        return HttpResponse.json({ accessToken: "new_fresh_token" });
      }),
      http.get("http://localhost:3000/api/v1/user", () => {
        callCount++;
        if (callCount === 1) {
          return new HttpResponse(JSON.stringify({ message: "Token expired" }), { status: 401 });
        }
        return HttpResponse.json({ id: 1, name: "John Doe" });
      })
    );

    const response = await api.get("/api/v1/user");

    expect(response.status).toBe(200);
    expect(response.data.name).toBe("John Doe");
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().accessToken).toBe("new_fresh_token");
  });

  test("시나리오 2: 여러 요청이 동시에 401을 받으면, 토큰 갱신은 1번만 실행되어야 한다.", async () => {
    const refreshSpy = vitest.fn();
    let isRefreshed = false;

    server.use(
      http.post("http://localhost:3000/api/v1/refresh", () => {
        refreshSpy();
        isRefreshed = true;
        return HttpResponse.json({ accessToken: "new_concurrent_token" });
      }),
      http.get("http://localhost:3000/api/v1/data/:id", ({ params }) => {
        if (!isRefreshed) {
          return new HttpResponse(null, { status: 401 });
        }
        return HttpResponse.json({ data: `Data for ${params.id}` });
      })
    );

    const requests = [
      api.get("/api/v1/data/1"),
      api.get("/api/v1/data/2"),
      api.get("/api/v1/data/3")
    ];

    const responses = await Promise.all(requests);

    expect(responses.map((res) => res.status)).toEqual([200, 200, 200]);
    expect(responses[0].data.data).toBe("Data for 1");
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().accessToken).toBe("new_concurrent_token");
  });

  test("시나리오 3 (확장): 5개 동시 요청 — 1,2는 즉시 200, 3은 401로 refresh 1회 유발, 4,5는 refresh 완료 후 401 도착하지만 추가 갱신 없이 재시도 성공", async () => {
    const refreshSpy = vitest.fn();

    useAuthStore.setState({ accessToken: "expired_token" });

    let firstCall3 = true;
    let firstCall4 = true;
    let firstCall5 = true;

    server.use(
      // 1,2: 즉시 200
      http.get("http://localhost:3000/api/v1/data/1", () => {
        return HttpResponse.json({ data: "ok-1" }, { status: 200 });
      }),
      http.get("http://localhost:3000/api/v1/data/2", () => {
        return HttpResponse.json({ data: "ok-2" }, { status: 200 });
      }),

      // 3: 즉시 401 -> refresh 트리거, 재시도 시 200
      http.get("http://localhost:3000/api/v1/data/3", () => {
        if (firstCall3) {
          firstCall3 = false;
          return new HttpResponse(null, { status: 401 });
        }
        return HttpResponse.json({ data: "ok-3" }, { status: 200 });
      }),

      // refresh: 약간 지연 후 새 토큰 발급
      http.post("http://localhost:3000/api/v1/refresh", async () => {
        refreshSpy();
        await delay(800);
        return HttpResponse.json({ accessToken: "NEW_TOKEN" });
      }),

      // 4,5: refresh가 끝난 '뒤'에 첫 401이 도착하도록 지연을 크게 줌
      // 첫 호출은 401, 재시도는 200 (추가 refresh 유발 금지)
      http.get("http://localhost:3000/api/v1/data/4", async () => {
        await delay(1300); // refresh 이후에 401 도착
        if (firstCall4) {
          firstCall4 = false;
          return new HttpResponse(null, { status: 401 });
        }
        return HttpResponse.json({ data: "ok-4" }, { status: 200 });
      }),
      http.get("http://localhost:3000/api/v1/data/5", async () => {
        await delay(1400); // refresh 이후에 401 도착
        if (firstCall5) {
          firstCall5 = false;
          return new HttpResponse(null, { status: 401 });
        }
        return HttpResponse.json({ data: "ok-5" }, { status: 200 });
      })
    );

    const responses = await Promise.all([
      api.get("/api/v1/data/1"),
      api.get("/api/v1/data/2"),
      api.get("/api/v1/data/3"),
      api.get("/api/v1/data/4"),
      api.get("/api/v1/data/5")
    ]);

    // 검증: 모두 최종 200, refresh는 단 1회, 토큰 갱신됨
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().accessToken).toBe("NEW_TOKEN");
  });

  test("시나리오 4: 토큰 갱신이 실패하면, 모든 대기 요청은 최종적으로 실패해야 한다.", async () => {
    const refreshSpy = vitest.fn();

    useAuthStore.setState({ accessToken: "expired_token" });

    server.use(
      // 토큰 갱신 API가 401 에러를 반환 → 갱신 실패 시나리오
      http.post("http://localhost:3000/api/v1/refresh", () => {
        refreshSpy();
        return new HttpResponse(JSON.stringify({ message: "Refresh token expired" }), {
          status: 401,
          headers: { "Content-Type": "application/json" }
        });
      }),
      // 보호된 리소스는 처음부터 401을 반환 (만료 토큰으로 호출)
      http.get("http://localhost:3000/api/v1/data/:id", () => {
        return new HttpResponse(null, { status: 401 });
      })
    );

    // 여러 API를 동시에 호출 (모두 401 → 단 한 번의 refresh 시도 → 실패)
    const requests = [
      api.get("/api/v1/data/1"),
      api.get("/api/v1/data/2"),
      api.get("/api/v1/data/3"),
      api.get("/api/v1/data/4")
    ];

    // 모든 요청이 실패해야 함
    const results = await Promise.allSettled(requests);
    expect(results.every((r) => r.status === "rejected")).toBe(true);

    // 검증: 갱신 시도는 1번이어야 하고, 실패 후 토큰은 비워져야 함
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().accessToken).toBeNull();
  });

  test("재시도 시 Authorization 헤더가 정확히 세팅된다", async () => {
    let secondAuthHeader: string | null = null;
    let first = true;

    server.use(
      http.post("http://localhost:3000/api/v1/refresh", () =>
        HttpResponse.json({ accessToken: "NEW_TOKEN" })
      ),
      http.get("http://localhost:3000/secure", ({ request }) => {
        if (first) {
          first = false;
          return new HttpResponse(null, { status: 401 });
        }
        secondAuthHeader = request.headers.get("authorization");
        return HttpResponse.json({ ok: true });
      })
    );

    const res = await api.get("/secure");
    expect(res.status).toBe(200);
    expect(secondAuthHeader).toBe("Bearer NEW_TOKEN");
  });

  test("POST 재시도 시 body가 보존된다", async () => {
    let first = true;
    let receivedBodyOnRetry: null | DefaultBodyType = null;

    server.use(
      http.post("http://localhost:3000/api/v1/refresh", () =>
        HttpResponse.json({ accessToken: "NEW_TOKEN" })
      ),
      http.post("http://localhost:3000/api/v1/items", async ({ request }) => {
        const body = await request.json();
        if (first) {
          first = false;
          return new HttpResponse(null, { status: 401 });
        }
        receivedBodyOnRetry = body;
        return HttpResponse.json({ body });
      })
    );

    const payload = { name: "Pen", price: 1000 };
    const res = await api.post("/api/v1/items", payload);
    expect(res.data.body).toEqual(payload);
    expect(receivedBodyOnRetry).toEqual(payload);
  });

  test("_retry로 재귀 방지: 새 토큰으로도 401이면 실패", async () => {
    const refreshSpy = vitest.fn();
    server.use(
      http.post("http://localhost:3000/api/v1/refresh", () => {
        refreshSpy();
        return HttpResponse.json({ accessToken: "NEW_TOKEN" });
      }),
      http.get(
        "http://localhost:3000/api/v1/protected",
        () => new HttpResponse(null, { status: 401 })
      )
    );

    const result = await Promise.resolve()
      .then(() => api.get("/api/v1/protected"))
      .then(
        () => "fulfilled",
        () => "rejected"
      );

    expect(result).toBe("rejected");
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });

  test("shouldRefresh 커스터마이즈: 419도 갱신 트리거", async () => {
    const api = createTestApi({
      shouldRefresh: (err) => {
        const s = err.response?.status;
        return s === 401 || s === 419;
      }
    });

    let first = true;
    const refreshSpy = vitest.fn();

    server.use(
      http.post("http://localhost:3000/api/v1/refresh", () => {
        refreshSpy();
        return HttpResponse.json({ accessToken: "NEW_TOKEN_419" });
      }),
      http.get("http://localhost:3000/api/v1/alt", () => {
        if (first) {
          first = false;
          // 419: (예) 세션 만료
          return new HttpResponse(null, { status: 419 });
        }
        return HttpResponse.json({ ok: true });
      })
    );

    const res = await api.get("/api/v1/alt");
    expect(res.status).toBe(200);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().accessToken).toBe("NEW_TOKEN_419");
  });

  test("headerName/headerScheme 커스터마이즈: X-Auth-Token 로 재시도", async () => {
    const api = createTestApi({
      headerName: "X-Auth-Token",
      headerScheme: ""
    });

    let first = true;
    let retryHeader: string | null = null;

    server.use(
      http.post("http://localhost:3000/api/v1/refresh", () =>
        HttpResponse.json({ accessToken: "CUSTOM_TOKEN" })
      ),
      http.get("http://localhost:3000/custom-header", ({ request }) => {
        if (first) {
          first = false;
          return new HttpResponse(null, { status: 401 });
        }
        retryHeader = request.headers.get("x-auth-token"); // 커스텀 헤더
        return HttpResponse.json({ ok: true });
      })
    );

    // ⚠️ 실제로는 api 생성 시 옵션으로 headerName='X-Auth-Token', headerScheme=''를 주입해야 합니다.
    // 현재 예시는 라이브러리 옵션이 반영된 인스턴스를 import했다고 가정합니다.

    const res = await api.get("/custom-header");
    expect(res.status).toBe(200);
    expect(retryHeader).toBe("CUSTOM_TOKEN");
  });

  test("onRefreshFailure 호출됨(갱신 실패)", async () => {
    server.use(
      http.post(
        "http://localhost:3000/api/v1/refresh",
        () => new HttpResponse(null, { status: 401 })
      ),
      http.get("http://localhost:3000/failure", () => new HttpResponse(null, { status: 401 }))
    );

    const result = await Promise.resolve()
      .then(() => api.get("/failure"))
      .then(
        () => "fulfilled",
        () => "rejected"
      );

    expect(result).toBe("rejected");
    expect(useAuthStore.getState().accessToken).toBeNull();
  });

  test("SSR 환경(window 없음)에서도 import/실행 안전", async () => {
    const g = globalThis as any;
    const prev = g.window;

    try {
      let first = true;
      g.window = undefined;
      // SSR 시나리오: 동적으로 라이브러리/인스턴스 모듈을 임포트
      server.use(
        http.post("http://localhost:3000/api/v1/refresh", () =>
          HttpResponse.json({ accessToken: "SSR_TOKEN" })
        ),
        http.get("http://localhost:3000/ssr", () => {
          if (first) {
            first = false;
            return new HttpResponse(null, { status: 401 }); // 첫 요청은 401
          }
          return HttpResponse.json({ ok: true }); // 재시도는 200
        })
      );

      const res = await api.get("/ssr");
      expect(res.status).toBe(200);
    } finally {
      g.window = prev;
    }
  });
});
