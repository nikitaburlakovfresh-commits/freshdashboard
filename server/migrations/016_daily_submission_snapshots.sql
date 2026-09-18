-- Pin linked task submissions at the moment a daily journal is submitted.
-- Rework can add new links, but cannot rewrite a previous daily submission.
SET LOCAL search_path = pilot_r1, public, pg_catalog;
CREATE TABLE daily_submission_links (
  daily_submission_id uuid NOT NULL REFERENCES submissions(id),
  task_submission_id uuid NOT NULL REFERENCES submissions(id),
  PRIMARY KEY(daily_submission_id,task_submission_id)
);
CREATE TRIGGER daily_submission_links_immutable BEFORE UPDATE OR DELETE ON daily_submission_links
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
