import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

const API_BASE = import.meta.env.VITE_API_URL || "";

export interface User {
  id: string;
  name?: string | null;
  email?: string | null;
  image?: string | null;
  role?: string;
}

export interface Session {
  user: User | null;
}

// Fetch current session/user
export function useSession() {
  return useQuery({
    queryKey: ["session"],
    queryFn: async (): Promise<Session> => {
      const res = await fetch(`${API_BASE}/api/me`, {
        credentials: "include",
      });
      if (!res.ok) {
        return { user: null };
      }
      const data = await res.json();
      return { user: data.user };
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: true,
  });
}

// Sign in - redirects to GitHub OAuth
export function signIn() {
  const callbackUrl = encodeURIComponent(window.location.origin);
  window.location.href = `${API_BASE}/api/auth/signin/github?callbackUrl=${callbackUrl}`;
}

// Sign out
export function useSignOut() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      // Get CSRF token first
      const csrfRes = await fetch(`${API_BASE}/api/auth/csrf`, {
        credentials: "include",
      });
      const { csrfToken } = await csrfRes.json();

      // Sign out
      await fetch(`${API_BASE}/api/auth/signout`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `csrfToken=${csrfToken}`,
      });
    },
    onSuccess: () => {
      queryClient.setQueryData(["session"], { user: null });
      window.location.href = "/login";
    },
  });
}

// Check if user is authenticated
export function useIsAuthenticated() {
  const { data, isLoading } = useSession();
  return {
    isAuthenticated: !!data?.user,
    isLoading,
    user: data?.user,
  };
}
