import axios, { AxiosError, AxiosInstance, AxiosRequestConfig } from "axios";

export type CreateTokenAxiosOptions = {
  baseURL?: string;
  withCredentials?: boolean;

  /** 현재 액세스 토큰을 가져오기 */
  getAccessToken: () => string | null | undefined;

  /** 새 액세스 토큰을 저장하기 */
  setAccessToken: (token: string | null) => void;

  /** refresh 호출을 수행해 새 액세스 토큰을 반환 */
  refreshRequest: (refreshAxios: AxiosInstance) => Promise<string>;

  /** 401 이외의 상태/규칙을 쓰고 싶을 때 */
  shouldRefresh?: (error: AxiosError) => boolean;

  /** refresh 실패 시 동작(로그아웃/리디렉션 등) */
  onRefreshFailure?: (error: AxiosError) => void | Promise<void>;

  /** Authorization 같은 헤더명 */
  headerName?: string; // default: "Authorization"

  /** "Bearer " 같은 prefix. 빈 문자열도 허용 */
  headerScheme?: string; // default: "Bearer "

  /** 재시도 플래그 키 */
  retryFlagKey?: string; // default: "_retry"

  /** refreshInstance 의 커스터마이징 (옵션) */
  createRefreshAxios?: () => AxiosInstance;

  /** 요청 전 토큰 주입 여부 제어(기본 true) */
  injectTokenOnRequest?: boolean;
};

type InternalConfig = AxiosRequestConfig & { [key: string]: any };

export function createTokenAxios(opts: CreateTokenAxiosOptions) {
  const {
    baseURL,
    withCredentials = true,
    getAccessToken,
    setAccessToken,
    refreshRequest,
    shouldRefresh = (error) => error.response?.status === 401,
    onRefreshFailure,
    headerName = "Authorization",
    headerScheme = "Bearer ",
    retryFlagKey = "_retry",
    createRefreshAxios,
    injectTokenOnRequest = true
  } = opts;

  const axiosInstance = axios.create({ baseURL, withCredentials });
  const refreshAxios = createRefreshAxios
    ? createRefreshAxios()
    : axios.create({ baseURL, withCredentials });

  let refreshPromise: Promise<string> | null = null;

  // 요청 인터셉터: 매 요청마다 토큰 주입
  if (injectTokenOnRequest) {
    axiosInstance.interceptors.request.use((config) => {
      const token = getAccessToken();
      if (token && headerName) {
        config.headers = config.headers ?? {};
        (config.headers as any)[headerName] = headerScheme ? `${headerScheme}${token}` : token;
      }
      return config;
    });
  }

  // 응답 인터셉터: 갱신 로직
  axiosInstance.interceptors.response.use(
    (res) => res,
    async (error: AxiosError) => {
      const originalRequest = error.config as InternalConfig | undefined;

      if (!axios.isAxiosError(error) || !originalRequest) {
        return Promise.reject(error);
      }

      if (!shouldRefresh(error)) {
        return Promise.reject(error);
      }

      // 이미 재시도한 요청이면 중단
      if (originalRequest[retryFlagKey]) {
        return Promise.reject(error);
      }
      originalRequest[retryFlagKey] = true;

      const currentToken = getAccessToken();
      const currentHeaderValue = currentToken
        ? headerScheme
          ? `${headerScheme}${currentToken}`
          : currentToken
        : undefined;
      const requestHeaderValue = originalRequest.headers?.[headerName];

      // 1) 이미 다른 요청이 refresh 중이면 그 결과를 기다림
      if (refreshPromise) {
        try {
          const newToken = await refreshPromise;
          originalRequest.headers = originalRequest.headers ?? {};
          if (headerName && newToken) {
            (originalRequest.headers as any)[headerName] = headerScheme
              ? `${headerScheme}${newToken}`
              : newToken;
          }
          return axiosInstance(originalRequest);
        } catch (e) {
          return Promise.reject(e);
        }
      }

      // 2) 지각된 만료(요청에 실린 토큰 != 현재 보관 토큰) → 현재 토큰으로 재시도
      if (requestHeaderValue && currentHeaderValue && requestHeaderValue !== currentHeaderValue) {
        originalRequest.headers = originalRequest.headers ?? {};
        (originalRequest.headers as any)[headerName] = currentHeaderValue;
        return axiosInstance(originalRequest);
      }

      // 3) 실제 refresh 수행(내가 총대)
      refreshPromise = (async () => {
        try {
          const newAccessToken = await refreshRequest(refreshAxios);
          setAccessToken(newAccessToken);
          return newAccessToken;
        } catch (e) {
          // 실패
          const axErr = e as AxiosError;
          try {
            await onRefreshFailure?.(axErr);
          } finally {
            setAccessToken(null);
          }
          throw axErr;
        } finally {
          // 다음 갱신을 위해 풀어줌
          refreshPromise = null;
        }
      })();

      try {
        const newToken = await refreshPromise;
        originalRequest.headers = originalRequest.headers ?? {};
        if (headerName && newToken) {
          (originalRequest.headers as any)[headerName] = headerScheme
            ? `${headerScheme}${newToken}`
            : newToken;
        }
        return axiosInstance(originalRequest);
      } catch (e) {
        return Promise.reject(e);
      }
    }
  );

  return {
    /** 보호된 API 호출용 axios 인스턴스 */
    client: axiosInstance,

    /** (선택) refresh axios 인스턴스 */
    refreshAxios,

    /** 외부에서 토큰 교체가 필요할 때 */
    setAccessToken,
    getAccessToken
  };
}

export type TokenAxiosReturn = {
  client: AxiosInstance;
  refreshAxios: AxiosInstance;
  setAccessToken: (t: string | null) => void;
  getAccessToken: () => string | null | undefined;
};
