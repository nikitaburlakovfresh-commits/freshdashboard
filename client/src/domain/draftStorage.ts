import type { FieldDrafts } from './taskForm';

/**
 * Черновик формы в браузере.
 *
 * Три бага старого портала, из-за которых руководители теряли заполненное:
 *
 * 1. Человек заполнял форму на компьютере, потом заходил с телефона — и форма
 *    «слетала». На сервер попадает только сохранённое, поэтому набранный, но не
 *    отправленный текст исчезал вместе с закрытой вкладкой.
 * 2. Пропадал интернет, форма не сохранялась, и введённое пропадало.
 * 3. Интернет появлялся через полчаса, и форма возвращала более старую версию,
 *    молча затирая то, что за это время сохранилось с другого устройства.
 *
 * Здесь закрывается первая и вторая беда: несохранённые значения лежат в
 * localStorage этого браузера и восстанавливаются при возврате на страницу, даже
 * после перезагрузки или падения связи. Третья беда решается не здесь, а
 * проверкой версии поля на сервере: старое значение не может перезаписать новое
 * молча, конфликт показывается человеку с обоими значениями.
 *
 * Черновик привязан к задаче И к пользователю: на общем компьютере в салоне
 * чужой набранный текст не должен подставиться в форму следующего человека.
 *
 * Локальный черновик — не сохранение. Он никогда не выдаётся за сохранённое
 * значение: страница обязана показывать «не сохранено на сервере», пока сервер
 * не подтвердил запись.
 */
const PREFIX = 'fresh.draft.v1';
/** Черновик старше семи суток не восстанавливается: это уже не «сегодняшняя работа». */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface StoredDraft {
  saved_at: number;
  /** Только несохранённые значения: path → набранный текст. */
  values: Record<string, string>;
}

function key(workItemId: string, userId: string) { return `${PREFIX}:${userId}:${workItemId}`; }

function storage(): Storage | null {
  // В приватном режиме и при запрете хранилища обращение бросает исключение.
  // Потеря черновика хуже неработающей страницы, но падать здесь нельзя.
  try { const s = window.localStorage; s.getItem(PREFIX); return s; } catch { return null; }
}

/** Сохранить несохранённые значения. Совпадающие с сервером не хранятся. */
export function saveLocalDraft(workItemId: string, userId: string, drafts: FieldDrafts): void {
  const s = storage(); if (!s) return;
  const values: Record<string, string> = {};
  for (const [path, d] of Object.entries(drafts)) if (d.value !== d.baseValue) values[path] = d.value;
  try {
    if (!Object.keys(values).length) { s.removeItem(key(workItemId, userId)); return; }
    s.setItem(key(workItemId, userId), JSON.stringify({ saved_at: Date.now(), values } as StoredDraft));
  } catch { /* переполненное хранилище не должно ломать заполнение */ }
}

export function clearLocalDraft(workItemId: string, userId: string): void {
  const s = storage(); if (!s) return;
  try { s.removeItem(key(workItemId, userId)); } catch { /* см. выше */ }
}

/**
 * Восстановить черновик поверх значений с сервера.
 *
 * Значение из браузера подставляется только если оно отличается от серверного.
 * Если за это время то же поле сохранили с другого устройства и там оказался тот
 * же текст — конфликта нет, и напоминать о нём незачем.
 *
 * Возвращается список восстановленных полей, чтобы страница честно сказала, что
 * именно ждёт отправки, а не делала вид, что всё сохранено.
 */
export function restoreLocalDraft(
  workItemId: string, userId: string, drafts: FieldDrafts,
): { drafts: FieldDrafts; restored: string[]; saved_at: number | null } {
  const s = storage();
  if (!s) return { drafts, restored: [], saved_at: null };
  let stored: StoredDraft | null = null;
  try {
    const raw = s.getItem(key(workItemId, userId));
    stored = raw ? JSON.parse(raw) as StoredDraft : null;
  } catch { stored = null; }
  if (!stored || typeof stored.saved_at !== 'number' || !stored.values) return { drafts, restored: [], saved_at: null };
  if (Date.now() - stored.saved_at > MAX_AGE_MS) { clearLocalDraft(workItemId, userId); return { drafts, restored: [], saved_at: null }; }
  const next: FieldDrafts = { ...drafts };
  const restored: string[] = [];
  for (const [path, value] of Object.entries(stored.values)) {
    const current = next[path];
    // Поля, которого больше нет в схеме, не восстанавливаем: подставлять
    // значение в несуществующее поле нельзя.
    if (!current || typeof value !== 'string') continue;
    if (value === current.baseValue) continue;
    next[path] = { ...current, value };
    restored.push(path);
  }
  return { drafts: next, restored, saved_at: restored.length ? stored.saved_at : null };
}
