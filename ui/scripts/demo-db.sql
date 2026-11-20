-- A made-up "read replica" of the payments service, for the demo recordings
-- (.claude/skills/sandboxes/demo-reset.md). Every date is relative to now(), so it is always fresh,
-- and setseed() makes the same rows every time. It carries the evidence three
-- tracked stories point at:
--   - refunds $0.01 short, because fees and interest are worked out per
--     transaction and rounded down (the half-cent rounding bug);
--   - the nightly reconciliation job failing about once a week on a lock that the
--     statement export holds (the "lock timeout" story);
--   - a merchant whose payout schedule changed mid-cycle, leaving a split payout
--     labelled with the wrong period (the long-titled bug).
-- Rebuilt from scratch on every run. A replica of a system that never existed,
-- kept exactly as current as the real ones.
DROP SCHEMA IF EXISTS payments CASCADE;
CREATE SCHEMA payments;
SET search_path = payments;
SELECT setseed(0.43);

CREATE TABLE merchants (
  id int PRIMARY KEY, name text NOT NULL, state text NOT NULL, currency text NOT NULL,
  risk text NOT NULL, payout_schedule text NOT NULL, schedule_changed_at timestamptz
);
INSERT INTO merchants VALUES
  (1, 'Northwind Coffee', 'WA', 'USD', 'low', 'daily', NULL),
  (2, 'Trailhead Outdoor', 'CO', 'USD', 'low', 'daily', NULL),
  (3, 'Paper Crane Stationery', 'OR', 'USD', 'medium', 'daily', NULL),
  (4, 'Lumen Games', 'TX', 'USD', 'high', 'weekly', now() - interval '4 days'),
  (5, 'Harbor Books', 'MA', 'USD', 'low', 'daily', NULL),
  (6, 'Bayou Street Eats', 'LA', 'USD', 'medium', 'daily', NULL);

CREATE TABLE payments (
  id bigint PRIMARY KEY, merchant_id int NOT NULL REFERENCES merchants, created_at timestamptz NOT NULL,
  currency text NOT NULL, amount_minor bigint NOT NULL, status text NOT NULL, idempotency_key text NOT NULL
);
INSERT INTO payments
SELECT g, m.id, now() - (random() * interval '30 days'), m.currency,
       500 + floor(random() * 25000),
       CASE WHEN random() < 0.95 THEN 'captured' ELSE 'failed' END,
       'idem_' || lpad(g::text, 6, '0')
FROM generate_series(1, 4000) g
JOIN merchants m ON m.id = 1 + (g % 6);

-- Duplicate captures: the same idempotency key captured twice, about once a day.
INSERT INTO payments
SELECT 100000 + row_number() OVER (), merchant_id, created_at + interval '31 seconds', currency, amount_minor, 'captured', idempotency_key
FROM payments WHERE id % 140 = 0 AND status = 'captured';

CREATE TABLE refunds (
  id bigint PRIMARY KEY, payment_id bigint NOT NULL REFERENCES payments, created_at timestamptz NOT NULL,
  currency text NOT NULL, requested_minor bigint NOT NULL, refunded_minor bigint NOT NULL, reason text NOT NULL,
  fee_minor numeric(12, 4) NOT NULL
);
INSERT INTO refunds
-- The fee on each refund is worked out per transaction to a fraction of a cent and
-- rounded down before it is netted, so about one refund in twenty is a cent short.
SELECT row_number() OVER (), p.id, p.created_at + interval '2 days', p.currency, p.amount_minor / 2,
       CASE WHEN f - floor(f) >= 0.5 THEN p.amount_minor / 2 - 1 ELSE p.amount_minor / 2 END,
       (ARRAY['duplicate', 'fraudulent', 'requested_by_customer', 'product_not_received'])[1 + floor(random() * 4)::int],
       round(f::numeric, 4)
FROM (SELECT *, CASE WHEN random() < 0.05 THEN 0.5 + random() * 0.49 ELSE random() * 0.49 END AS f FROM payments) p
WHERE p.status = 'captured' AND random() < 0.12;

CREATE TABLE disputes (
  id int PRIMARY KEY, payment_id bigint NOT NULL REFERENCES payments, opened_at timestamptz NOT NULL,
  evidence_due date NOT NULL, status text NOT NULL, merchant_notified boolean NOT NULL
);
INSERT INTO disputes
SELECT row_number() OVER (), p.id, o, (o + interval '7 days')::date,
       CASE WHEN o > now() - interval '7 days' THEN 'needs_response' ELSE (ARRAY['won', 'lost'])[1 + floor(random() * 2)::int] END,
       false
FROM (SELECT id, created_at + interval '9 days' AS o FROM payments WHERE status = 'captured' AND id % 97 = 0) p
WHERE o < now();

CREATE TABLE payouts (
  id int PRIMARY KEY, merchant_id int NOT NULL REFERENCES merchants, scheduled_for date NOT NULL,
  period_start date NOT NULL, period_end date NOT NULL, amount_minor bigint NOT NULL, status text NOT NULL
);
INSERT INTO payouts
SELECT row_number() OVER (), m.id, d::date, (d - interval '1 day')::date, (d - interval '1 day')::date,
       20000 + floor(random() * 400000), CASE WHEN d::date < current_date THEN 'paid' ELSE 'scheduled' END
FROM merchants m, generate_series(current_date - 20, current_date + 2, interval '1 day') d
WHERE m.id <> 4 OR d < now() - interval '4 days';
-- Lumen Games moved from daily to weekly 4 days ago: the pending balance split in two,
-- and the second payout, due the coming Friday, carries the old daily period.
-- Every date here is relative to the day the script runs.
INSERT INTO payouts (id, merchant_id, scheduled_for, period_start, period_end, amount_minor, status)
SELECT max(id) + 1, 4, current_date - 3, current_date - 4, current_date - 4, 81250, 'paid' FROM payouts;
INSERT INTO payouts (id, merchant_id, scheduled_for, period_start, period_end, amount_minor, status)
SELECT max(id) + 1, 4, current_date + ((5 - extract(isodow FROM current_date)::int + 6) % 7) + 1, current_date - 4, current_date - 4, 264900, 'scheduled' FROM payouts;

CREATE TABLE job_runs (
  id serial PRIMARY KEY, job text NOT NULL, started_at timestamptz NOT NULL, finished_at timestamptz,
  status text NOT NULL, rows_processed int, error text
);
-- The statement export starts at 01:55 and holds ledger_entries until about 02:20.
INSERT INTO job_runs (job, started_at, finished_at, status, rows_processed, error)
SELECT 'statement-export', d + interval '1 hour 55 minutes', d + interval '2 hours 18 minutes' + random() * interval '6 minutes', 'succeeded', 180000 + floor(random() * 20000), NULL
FROM generate_series(date_trunc('day', now()) - interval '30 days', date_trunc('day', now()) - interval '1 day', interval '1 day') d;
-- Reconciliation at 02:00: on the days the export runs long, it times out on the lock.
INSERT INTO job_runs (job, started_at, finished_at, status, rows_processed, error)
SELECT 'nightly-reconciliation', d + interval '2 hours',
       d + interval '2 hours' + CASE WHEN fail THEN interval '10 minutes' ELSE interval '14 minutes' END,
       CASE WHEN fail THEN 'failed' ELSE 'succeeded' END,
       CASE WHEN fail THEN NULL ELSE 52000 + floor(random() * 4000)::int END,
       CASE WHEN fail THEN 'canceling statement due to lock timeout: waiting for AccessExclusiveLock on relation ledger_entries held by statement-export' END
FROM (SELECT d, (extract(doy FROM d)::int % 7 = 3 OR d = date_trunc('day', now()) - interval '1 day') AS fail
      FROM generate_series(date_trunc('day', now()) - interval '30 days', date_trunc('day', now()) - interval '1 day', interval '1 day') d) x;

CREATE VIEW refund_shortfalls AS
SELECT m.name AS merchant, count(*) AS short_refunds, sum(r.requested_minor - r.refunded_minor) AS short_by_cents
FROM refunds r JOIN payments p ON p.id = r.payment_id JOIN merchants m ON m.id = p.merchant_id
WHERE r.refunded_minor < r.requested_minor GROUP BY m.name;

-- Dollars for the screen: cents divided by 100 come back as numeric with sixteen
-- decimals, so these round to cents once, here, as numeric(12,2).
CREATE VIEW merchant_totals AS
SELECT m.name AS merchant, m.state, count(p.*) AS payments,
       round(coalesce(sum(p.amount_minor) FILTER (WHERE p.status = 'captured'), 0) / 100.0, 2)::numeric(12, 2) AS captured_usd,
       round(coalesce((SELECT sum(r.refunded_minor) FROM refunds r JOIN payments q ON q.id = r.payment_id WHERE q.merchant_id = m.id), 0) / 100.0, 2)::numeric(12, 2) AS refunded_usd
FROM merchants m LEFT JOIN payments p ON p.merchant_id = m.id
GROUP BY m.id, m.name, m.state;

-- The past week stays in, paid or not: it holds the paid half of Lumen Games' split.
CREATE VIEW upcoming_payouts AS
SELECT m.name AS merchant, o.scheduled_for, o.period_start, o.period_end,
       round(o.amount_minor / 100.0, 2)::numeric(12, 2) AS amount_usd, o.status
FROM payouts o JOIN merchants m ON m.id = o.merchant_id
WHERE o.scheduled_for >= current_date - 7;

COMMENT ON SCHEMA payments IS 'Made-up demo data for Toil UI recordings: Overdraft Federal, its merchants and this data do not exist.';
