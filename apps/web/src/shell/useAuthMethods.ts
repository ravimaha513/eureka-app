import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

export interface AuthMethods {
  password: boolean;
  google: boolean;
  dev: boolean;
}

/**
 * The sign-in methods the server offers. A failed fetch is an error (retried by react-query),
 * never cached as "no methods", so a blip cannot hide the password form for the whole session.
 */
export function useAuthMethods() {
  return useQuery({
    queryKey: ["auth-methods"],
    queryFn: () => api<AuthMethods>("/api/auth/methods"),
    staleTime: Infinity,
  });
}
