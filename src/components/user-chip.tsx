import { useState, useSyncExternalStore } from "react";
import { authEnabled, signOut } from "@/lib/auth/client";
import { hasGateSessionMarker } from "@/lib/auth/gate-session-marker";
import { useCurrentUser } from "@/lib/auth/use-current-user";

const subscribeToNothing = () => () => {};
const noGateSessionOnServer = () => false;

/**
 * Кто вошёл и как выйти, по-русски. Устроен как `UserButton` шаблона (`@/lib/auth/gates`): выход делает `signOut()`, а для сессии шлюза
 * кнопки выхода нет: следующий запрос сразу вернул бы вход.
 */
export function UserChip() {
  const user = useCurrentUser();
  const [signingOut, setSigningOut] = useState(false);
  const gateSession = useSyncExternalStore(
    subscribeToNothing,
    hasGateSessionMarker,
    noGateSessionOnServer,
  );
  if (!user) return null;
  const label = user.displayName ?? user.primaryEmail ?? "Аккаунт";
  return (
    <div className="flex min-h-11 min-w-0 items-center gap-3">
      {user.profileImageUrl ? (
        <img src={user.profileImageUrl} alt="" className="h-8 w-8 rounded-full object-cover" />
      ) : (
        <span
          aria-hidden="true"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-elevated text-sm font-medium"
        >
          {label.charAt(0).toUpperCase()}
        </span>
      )}
      <span className="min-w-0 truncate text-sm font-medium">{label}</span>
      {authEnabled && !gateSession ? (
        <button
          type="button"
          disabled={signingOut}
          onClick={() => {
            setSigningOut(true);
            // Успех уводит со страницы; при сбое кнопка снова доступна.
            void signOut().catch(() => setSigningOut(false));
          }}
          className="h-11 shrink-0 px-2 text-sm text-muted underline-offset-4 hover:underline disabled:no-underline"
        >
          {signingOut ? "Выходим…" : "Выйти"}
        </button>
      ) : null}
    </div>
  );
}
