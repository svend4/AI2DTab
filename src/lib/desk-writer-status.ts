import { create } from "zustand";
import { deskWho } from "@/lib/pm-api";

type WriterStatus = {
  /** Чей допуск лежит ниже. */
  userId: string | null;
  /** `null` — сервер ещё не ответил. */
  writer: boolean | null;
  load: (userId: string) => void;
};

/**
 * Допущен ли вошедший к записи, спросив сервер один раз на пользователя (список допущенных остаётся на сервере).
 * Сбой запроса считается «не допущен»: кнопки остаются серыми, а запись всё равно проверяет сервер.
 */
export const useWriterStatus = create<WriterStatus>((set, get) => ({
  userId: null,
  writer: null,
  load(userId) {
    if (get().userId === userId) return;
    set({ userId, writer: null });
    deskWho()
      .then((r) => {
        if (get().userId === userId) set({ writer: r.writer });
      })
      .catch(() => {
        if (get().userId === userId) set({ writer: false });
      });
  },
}));
