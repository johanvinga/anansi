import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { queryClient } from "../api/query-client";
import { apiRequest } from "../api/client";
import type { CurrentUser } from "../api/types";
import { AuthContext } from "./auth-state";

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    apiRequest<{ user: CurrentUser }>("GET", "/auth/me")
      .then((result) => setUser(result.user))
      .catch(() => setUser(null))
      .finally(() => setIsLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const result = await apiRequest<{ user: CurrentUser }>("POST", "/auth/login", { email, password });
    queryClient.clear();
    setUser(result.user);
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiRequest<void>("POST", "/auth/logout");
    } finally {
      queryClient.clear();
      setUser(null);
    }
  }, []);

  const value = useMemo(
    () => ({ user, isLoading, login, logout, setUser }),
    [user, isLoading, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
