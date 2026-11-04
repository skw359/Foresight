import { Navigate } from "react-router-dom";

import { useAuth } from "../auth/AuthContext";
import { AuthForm } from "./AuthForm";

export function LoginPage() {
  const { isAuthenticated } = useAuth();
  if (isAuthenticated) return <Navigate to="/" replace />;
  return <AuthForm mode="login" />;
}
