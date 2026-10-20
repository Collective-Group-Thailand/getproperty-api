-- getproperty-api 0030 — B5.4 staff tasks (D-090, D-213): one view over the open work of a building's staff —
-- reading requests (B3.3 / D-208), move-in / move-out inspections (B2.4), platform install orders (B6.1, read-only for
-- tenant staff), service work orders (B5.1) and parcels waiting at the desk (B5.3). Completing a task writes the source
-- aggregate through its own service; the view only lists. security_invoker: the caller's RLS applies to every source
-- (tenant, building and unit scopes), so a staff login sees only the rows its transaction may read.

CREATE VIEW ops.staff_task WITH (security_invoker = true) AS
  SELECT 'reading'::text AS type, r.id, r.tenant_id, r.building_id, ma.unit_id,
         r.status::text AS source_status, 'normal'::text AS priority, r.due_at, r.assignee_user_id,
         ma.code::text AS subject, r.asset_item_id, r.requested_at AS created_at
    FROM smart.reading_request r
    JOIN core.meter_assignment ma ON ma.id = r.meter_assignment_id
   WHERE r.status = 'open'
  UNION ALL
  SELECT 'inspection', i.id, i.tenant_id, i.building_id, i.unit_id,
         i.status::text, 'normal', i.scheduled_for, i.inspector_user_id,
         i.type::text, NULL::uuid, i.created_at
    FROM ops.inspection i
   WHERE i.status IN ('scheduled', 'in_progress')
  UNION ALL
  SELECT 'install', o.id, o.tenant_id, o.building_id, NULL::uuid,
         o.state::text, 'normal', o.due_at, o.assigned_to,
         o.kind::text, NULL::uuid, o.created_at
    FROM platform.install_order o
   WHERE o.state IN ('open', 'in_progress')
  UNION ALL
  SELECT 'work_order', w.id, w.tenant_id, w.building_id, w.unit_id,
         w.status::text, w.priority::text, w.scheduled_at, w.assignee_user_id,
         w.title, w.asset_item_id, w.created_at
    FROM ops.work_order w
   WHERE w.status IN ('open', 'assigned', 'accepted', 'in_progress')
  UNION ALL
  SELECT 'parcel', p.id, p.tenant_id, p.building_id, p.unit_id,
         p.status::text, 'normal', NULL::timestamptz, NULL::uuid,
         coalesce(p.carrier, ''), NULL::uuid, p.received_at
    FROM ops.parcel p
   WHERE p.status IN ('received', 'notified');
COMMENT ON VIEW ops.staff_task IS 'Open staff work of a building (B5.4): reading requests, inspections, install orders, work orders, parcels; completion writes the source aggregate (D-213).';

GRANT SELECT ON ops.staff_task TO gp_app, gp_platform, gp_reporting;
