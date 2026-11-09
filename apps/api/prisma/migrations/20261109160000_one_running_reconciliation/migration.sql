-- At most one RUNNING reconciliation per organisation (race-proof, enforced by the database).
CREATE UNIQUE INDEX "ReconciliationRun_one_running_per_org"
  ON "ReconciliationRun" ("organisationId")
  WHERE status = 'RUNNING';
