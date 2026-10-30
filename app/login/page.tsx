import type { Metadata } from "next";
import { GlossWordmark } from "@/components/brand/Gloss";
import { loginConfigured } from "@/lib/server/auth";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "Sign in" };
// Whether a password hash is set is read from the environment when the page is asked for, never frozen at build.
export const dynamic = "force-dynamic";

export default function LoginPage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[26rem] flex-col justify-center px-6 pb-16">
      <div className="mb-10">
        <GlossWordmark />
      </div>
      <h1 className="font-serif text-[34px] font-[420] leading-[1.1] tracking-[-0.02em] text-ink [font-variation-settings:'opsz'_72]">Your library, closed.</h1>
      <p className="mt-3 text-[15px] leading-relaxed text-ink-3">Gloss is a private reading room. Sign in with the password this server was set up with.</p>
      {loginConfigured() ? (
        <LoginForm />
      ) : (
        <p className="mt-8 rounded-[13px] border border-rule px-4 py-3.5 text-[13.5px] leading-snug text-ink-2" role="status">
          No password is set on this server, so nobody can sign in. Set <code className="font-mono text-[12.5px]">GLOSS_OWNER_PASSWORD_HASH</code> (make one with <code className="font-mono text-[12.5px]">npm run auth:hash</code>) and start it again.
        </p>
      )}
    </main>
  );
}
