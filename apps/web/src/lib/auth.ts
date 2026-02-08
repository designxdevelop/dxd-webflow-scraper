import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

const API_BASE = (import.meta.env.VITE_API_URL || "").replace(/\/+$/, "");

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

// Sign in - redirects to GitHub OAuth via form POST
export async function signIn() {
  // Get CSRF token first
  const csrfRes = await fetch(`${API_BASE}/api/auth/csrf`, {
    credentials: "include",
  });
  const { csrfToken } = await csrfRes.json();

  // Create a form and submit it to initiate OAuth
  const form = document.createElement("form");
  form.method = "POST";
  form.action = `${API_BASE}/api/auth/signin/github`;
  
  const csrfInput = document.createElement("input");
  csrfInput.type = "hidden";
  csrfInput.name = "csrfToken";
  csrfInput.value = csrfToken;
  form.appendChild(csrfInput);

  const callbackInput = document.createElement("input");
  callbackInput.type = "hidden";
  callbackInput.name = "callbackUrl";
  callbackInput.value = window.location.origin;
  form.appendChild(callbackInput);

  document.body.appendChild(form);
  form.submit();
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
