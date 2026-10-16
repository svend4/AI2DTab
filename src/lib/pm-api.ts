import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";

/**
 * Серверные вызовы стола. Режим A (docs/AUDIT.md, раздел 4.3) со списком допущенных (раздел 4.4):
 *  - `pmRead` открыт всем и пропускает только глаголы чтения;
 *  - `pmWrite` требует входа (`authMiddleware`: проверенный `context.userId`, отказ чужим сайтам); пишет только допущенный:
 *    подтверждённый адрес пользователя должен стоять в переменной окружения `DESK_WRITERS` (`desk-writers.ts`), остальные вошедшие
 *    получают отказ `not_writer` на всё, кроме чтения;
 *  - `deskWho` говорит вошедшему, допущен ли он (для серых кнопок); список наружу не отдаётся.
 * Что именно разрешено, решает `buildPmArgs` в `pm-request.ts`, а не имя вызова: строка, не подходящая под вызов, получает отказ
 * (`login_required`, `not_writer` и т. п.), и клиентская подсказка «какой вызов выбрать» ничего не открывает.
 * Параметра «файл» нет; лента PLANT приходит текстом, путь к её временному файлу выбирает сервер.
 * `ids` — список подтверждения массовой записи RAW и OBS (AUD-15): до 500 идентификаторов, проверяет и движок.
 */
const Input = z.object({
  line: z.string().min(1).max(4000),
  tape: z.string().max(200_000).optional(),
  ids: z
    .array(z.string().regex(/^[^\s,\p{Cc}]{1,200}$/u))
    .max(500)
    .optional(),
});

export const pmRead = createServerFn({ method: "POST" })
  .validator(Input)
  .handler(async ({ data }) => {
    const { execute } = await import("@/lib/pm-exec.server");
    return execute(data, null);
  });

export const pmWrite = createServerFn({ method: "POST" })
  .validator(Input)
  .middleware([authMiddleware])
  .handler(async ({ data, context }) => {
    const { execute } = await import("@/lib/pm-exec.server");
    const { isDeskWriter } = await import("@/lib/desk-writers.server");
    const writer = await isDeskWriter(context.userId);
    return execute(data, { id: context.userId, writer });
  });

export const deskWho = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { isDeskWriter } = await import("@/lib/desk-writers.server");
    return { writer: await isDeskWriter(context.userId) };
  });
