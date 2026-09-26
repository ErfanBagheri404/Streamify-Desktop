import type { Metadata } from "next";
import AuthScreen from "../components/AuthScreen";

export const metadata: Metadata = {
  title: "Sign In",
};

export default function SignInPage() {
  return (
    <main data-auth-page="true" className="flex-1">
      <AuthScreen mode="signin" />
    </main>
  );
}
