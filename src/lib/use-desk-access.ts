import { useEffect } from "react";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { deskAccess, type DeskAccess } from "@/lib/desk-access";
import { useWriterStatus } from "@/lib/desk-writer-status";
import { useDesk } from "@/lib/desk-store";

/** Режим A для интерфейса: вошёл ли посетитель и допущен ли к записи. Решение в `desk-access.ts`; сервер проверяет запись сам. */
export function useDeskAccess(): DeskAccess {
  const { user, isPending } = useCurrentUserState();
  const userId = user?.id ?? null;
  const load = useWriterStatus((s) => s.load);
  const writer = useWriterStatus((s) => (userId !== null && s.userId === userId ? s.writer : null));
  const snapshot = useDesk((s) => s.snapshot !== null);
  useEffect(() => {
    if (userId) load(userId);
  }, [userId, load]);
  return deskAccess({ user, isPending, writer, snapshot });
}
