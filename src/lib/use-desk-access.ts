import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { deskAccess, type DeskAccess } from "@/lib/desk-access";

/** Режим A для интерфейса: вошёл ли посетитель. Решение в `desk-access.ts`; сервер проверяет запись сам. */
export function useDeskAccess(): DeskAccess {
  const { user, isPending } = useCurrentUserState();
  return deskAccess({ user, isPending });
}
