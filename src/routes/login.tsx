import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { UserChip } from "@/components/user-chip";
import { GROK_PROVIDERS, authEnabled, signIn } from "@/lib/auth/client";
import { SignInGate } from "@/lib/auth/gates";

export const Route = createFileRoute("/login")({ component: Login });

function Providers() {
  const [failed, setFailed] = useState<string | null>(null);
  if (!authEnabled) return <p className="text-sm text-muted">Вход отключён в этой сборке.</p>;
  return (
    <div className="grid gap-3">
      {GROK_PROVIDERS.map((p) => (
        <button
          key={p.providerId}
          type="button"
          onClick={() => {
            setFailed(null);
            signIn(p.providerId, { callbackURL: "/" }).catch((e: unknown) =>
              setFailed(e instanceof Error ? e.message : "ошибка входа"),
            );
          }}
          className="h-11 rounded-md border border-border-strong bg-elevated px-4 text-sm font-medium"
        >
          Продолжить через {p.label}
        </button>
      ))}
      {failed ? (
        <p role="alert" className="text-sm text-warn">
          Войти не удалось: {failed}. Разрешите всплывающие окна и повторите.
        </p>
      ) : null}
    </div>
  );
}

function Login() {
  return (
    <main className="mx-auto grid min-h-dvh max-w-sm content-center gap-6 px-4 py-10 text-fg">
      <div>
        <h1 className="font-display text-3xl font-medium tracking-tight">Вход</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Читать стол можно без входа. Менять его — сажать ленту, принимать и вычитать объекты,
          запускать массовые операции — могут только допущенные аккаунты: вход нужен, чтобы стол
          узнал, кто вы.
        </p>
      </div>
      <SignInGate fallback={<Providers />}>
        <div className="grid gap-4">
          <p className="text-sm text-muted">Вы уже вошли.</p>
          <UserChip />
        </div>
      </SignInGate>
      <Link to="/" className="inline-flex h-11 items-center text-sm text-muted underline">
        К столу
      </Link>
    </main>
  );
}
