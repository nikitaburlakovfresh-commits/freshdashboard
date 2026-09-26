import React, { useCallback, useEffect, useState } from 'react';
import { listRegistrations, decideRegistration, type RegistrationRequest, type RegistrationZone } from '../api/adminSettings';
import { getRegistrationDirectory } from '../api/adminSettings';

/**
 * Очередь заявок на доступ.
 *
 * Подтверждение создаёт учётную запись и закрепление за филиалом одним
 * действием. Роль и филиал можно поправить здесь же: сотрудник мог указать их
 * неточно, а гонять его через отказ — лишний круг.
 *
 * Отказ требует причины: человек должен понимать, что исправить.
 */
export default function RegistrationRequestsPage() {
  const [status, setStatus] = useState('PENDING');
  const [items, setItems] = useState<RegistrationRequest[]>([]);
  const [roles, setRoles] = useState<{ code: string; display_name: string }[]>([]);
  const [branches, setBranches] = useState<{ id: string; display_name: string }[]>([]);
  const [zones, setZones] = useState<RegistrationZone[]>([]);
  const [edits, setEdits] = useState<Record<string, { role_code: string; org_unit_id: string; reason: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async (s: string) => {
    setError(null);
    try { const res = await listRegistrations(s); setItems(res.items); setZones(res.zones ?? []); }
    catch (err) { setError(err instanceof Error ? err.message : 'Не удалось прочитать заявки.'); }
  }, []);

  useEffect(() => { void load(status); }, [status, load]);
  useEffect(() => {
    getRegistrationDirectory().then(r => { setRoles(r.roles); setBranches(r.branches); }).catch(() => {});
  }, []);

  // РМ и дивизиональный руководитель закрепляются за зоной целиком.
  const zoneKind = (role: string) => role === 'REGIONAL_MANAGER' ? 'CLUSTER' : role === 'DIVISION_MANAGER' ? 'DIVISION' : null;
  const zoneOf = (role: string, branchId: string | null) =>
    zones.find(z => z.kind === zoneKind(role) && z.branches.some(b => b.id === branchId))?.id;
  // РМ регистрируется от УК без филиала: зона подбирается по фамилии в её названии.
  const zoneByName = (role: string, fullName: string) => {
    const words = fullName.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    // Совпадение по фамилии и имени сразу: «Игорь» встречается в двух зонах.
    const scored = zones.filter(z => z.kind === zoneKind(role))
      .map(z => ({ id: z.id, n: words.filter(w => z.display_name.toLowerCase().includes(w)).length }))
      .filter(x => x.n > 0).sort((a, b) => b.n - a.n);
    return scored.length && (scored.length === 1 || scored[0].n > scored[1].n) ? scored[0].id : undefined;
  };
  const edit = (r: RegistrationRequest) => edits[r.id] ?? {
    role_code: r.requested_role_code,
    org_unit_id: zoneOf(r.requested_role_code, r.requested_org_unit_id)
      ?? zoneByName(r.requested_role_code, r.full_name) ?? r.requested_org_unit_id ?? '',
    reason: '',
  };
  const patch = (id: string, k: 'role_code' | 'org_unit_id' | 'reason', v: string) =>
    setEdits(p => ({ ...p, [id]: { ...(p[id] ?? { role_code: '', org_unit_id: '', reason: '' }), [k]: v } }));

  const decide = async (r: RegistrationRequest, action: 'approve' | 'reject') => {
    const e = edit(r);
    setBusy(r.id); setError(null); setDone(null);
    try {
      await decideRegistration(r.id, action,
        action === 'approve'
          ? { role_code: e.role_code, org_unit_id: e.org_unit_id, reason: e.reason || undefined }
          : { reason: e.reason });
      setDone(action === 'approve'
        ? `Учётная запись ${r.login} создана${zones.some(z => z.id === e.org_unit_id)
          ? ` и закреплена за филиалами зоны «${zones.find(z => z.id === e.org_unit_id)!.display_name}»` : ' и закреплена за филиалом'}.`
        : `Заявка ${r.login} отклонена.`);
      await load(status);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось применить решение.');
    } finally { setBusy(null); }
  };

  return <div className="portal-page">
    <header className="overview-head">
      <div>
        <h1>Заявки на доступ</h1>
        <p className="overview-subline">
          Сотрудники регистрируются сами. Учётная запись создаётся только после
          вашего подтверждения.
        </p>
      </div>
    </header>

    <section className="portal-panel">
      <label className="role-view-field"><span>Показать</span>
        <select value={status} onChange={e => setStatus(e.target.value)}>
          <option value="PENDING">Ожидают решения</option>
          <option value="APPROVED">Подтверждённые</option>
          <option value="REJECTED">Отклонённые</option>
        </select></label>
    </section>

    {error && <p className="role-view-error">{error}</p>}
    {done && <p className="org-small">{done}</p>}
    {items.length === 0 && <section className="portal-panel"><p>Заявок в этом состоянии нет.</p></section>}

    {items.map(r => <section className="portal-panel" key={r.id}>
      <h2>{r.full_name} · {r.login}</h2>
      <p className="org-small">
        Подана {r.created_at} · просит роль «{r.role_name}»
        {r.org_unit_name ? ` · филиал ${r.org_unit_name}` : ' · ГК Fresh (управляющая компания)'}
        {r.primary_email ? ` · ${r.primary_email}` : ''}{r.phone ? ` · ${r.phone}` : ''}
      </p>
      {r.comment && <p className="org-small">Комментарий: {r.comment}</p>}

      {r.status !== 'PENDING' && <p className="org-small">
        Решение {r.decided_at} · {r.decided_by_login ?? '—'}
        {r.decision_reason ? ` · ${r.decision_reason}` : ''}
      </p>}

      {r.status === 'PENDING' && <>
        <label className="role-view-field"><span>Роль при подтверждении</span>
          <select value={edit(r).role_code} onChange={e => patch(r.id, 'role_code', e.target.value)}>
            {roles.map(x => <option key={x.code} value={x.code}>{x.display_name}</option>)}
          </select></label>
        {(() => {
          const kind = zoneKind(edit(r).role_code);
          const list = zones.filter(z => z.kind === kind);
          const picked = zones.find(z => z.id === edit(r).org_unit_id);
          return <>
            <label className="role-view-field"><span>{kind === 'DIVISION' ? 'Дивизион или филиал при подтверждении'
              : kind ? 'Зона РМ или филиал при подтверждении' : 'Филиал при подтверждении'}</span>
              <select value={edit(r).org_unit_id} onChange={e => patch(r.id, 'org_unit_id', e.target.value)}>
                <option value="">— выберите —</option>
                {list.length > 0 && <optgroup label={kind === 'DIVISION' ? 'Дивизион целиком' : 'Зона РМ целиком'}>
                  {list.map(z => <option key={z.id} value={z.id}>{z.display_name} · {z.branches.length} фил.</option>)}
                </optgroup>}
                <optgroup label="Один филиал">
                  {branches.map(b => <option key={b.id} value={b.id}>{b.display_name}</option>)}
                </optgroup>
              </select></label>
            {picked && <p className="org-small">Доступ будет выдан на филиалы: {picked.branches.map(b => b.display_name).join(', ')}.</p>}
          </>;
        })()}
        <label className="role-view-field"><span>Основание решения (обязательно для отказа)</span>
          <input type="text" maxLength={500} value={edit(r).reason}
            onChange={e => patch(r.id, 'reason', e.target.value)} /></label>
        <div className="role-view-actions">
          <button type="button" className="btn" disabled={busy === r.id}
            onClick={() => decide(r, 'reject')}>Отклонить</button>
          <button type="button" className="btn role-view-primary" disabled={busy === r.id}
            onClick={() => decide(r, 'approve')}>Подтвердить и создать доступ</button>
        </div>
      </>}
    </section>)}
  </div>;
}
