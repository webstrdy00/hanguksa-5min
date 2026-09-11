-- 문서 계약을 DB 레벨에서 강제하는 불변식.
-- 근거: 08 §1(revision immutable, answer 수정 금지, 세트 5개 고정), 09 §2, 07 §3
-- Drizzle 스키마로 표현할 수 없는 트리거/식 인덱스만 여기에 둔다.

-- ---------------------------------------------------------------------------
-- 1. updated_at 자동 갱신
--    애플리케이션이 빠뜨려도 DB 가 채운다. immutable 테이블에는 걸지 않는다.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER admin_users_set_updated_at BEFORE UPDATE ON admin_users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER exam_schedules_set_updated_at BEFORE UPDATE ON exam_schedules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER question_reports_set_updated_at BEFORE UPDATE ON question_reports
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER study_sessions_set_updated_at BEFORE UPDATE ON study_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER user_question_state_set_updated_at BEFORE UPDATE ON user_question_state
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER mastery_set_updated_at BEFORE UPDATE ON mastery
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER notification_consents_set_updated_at BEFORE UPDATE ON notification_consents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER idempotency_keys_set_updated_at BEFORE UPDATE ON idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER deletion_jobs_set_updated_at BEFORE UPDATE ON deletion_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER feature_flags_set_updated_at BEFORE UPDATE ON feature_flags
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. question_revisions 내용 immutable (08 §1, 09 §2)
--    수정은 새 revision 발행으로만 한다. 상태 전이(draft->...->voided)와
--    검수 메타 입력은 허용하되, 사용자가 본 내용 자체는 절대 바뀌지 않는다.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION question_revisions_guard_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.question_id IS DISTINCT FROM OLD.question_id
     OR NEW.revision IS DISTINCT FROM OLD.revision
     OR NEW.era IS DISTINCT FROM OLD.era
     OR NEW.topic IS DISTINCT FROM OLD.topic
     OR NEW.ability IS DISTINCT FROM OLD.ability
     OR NEW.difficulty IS DISTINCT FROM OLD.difficulty
     OR NEW.prompt IS DISTINCT FROM OLD.prompt
     OR NEW.choices IS DISTINCT FROM OLD.choices
     OR NEW.correct_index IS DISTINCT FROM OLD.correct_index
     OR NEW.explanation IS DISTINCT FROM OLD.explanation
     OR NEW.wrong_answer_notes IS DISTINCT FROM OLD.wrong_answer_notes
     OR NEW.memory_keyword IS DISTINCT FROM OLD.memory_keyword
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'question_revisions content is immutable (revision %); publish a new revision instead',
      OLD.revision
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER question_revisions_immutable
  BEFORE UPDATE ON question_revisions
  FOR EACH ROW EXECUTE FUNCTION question_revisions_guard_immutable();
--> statement-breakpoint

-- 발행된 revision 은 삭제할 수 없다. 과거 세션 재현과 감사에 필요하다 (09 §2).
CREATE OR REPLACE FUNCTION question_revisions_guard_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION
      'question_revisions can only be deleted while draft (revision % is %)',
      OLD.revision, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER question_revisions_no_delete
  BEFORE DELETE ON question_revisions
  FOR EACH ROW EXECUTE FUNCTION question_revisions_guard_delete();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. answers 제출 후 수정 금지 (08 §1)
--    void 처리도 answers 를 고치지 않는다. 집계에서 제외할 뿐이다 (07 §9).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION answers_guard_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'answers are immutable once submitted'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER answers_immutable
  BEFORE UPDATE ON answers
  FOR EACH ROW EXECUTE FUNCTION answers_guard_immutable();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. 세션 세트는 정확히 5문항 (08 §1 "시작 시 question_revision_ids 5개 고정")
--    DEFERRABLE 이라 세션 생성 트랜잭션 안에서 5행을 넣는 동안은 통과하고,
--    커밋 시점에 개수가 5가 아니면 트랜잭션 전체가 실패한다.
--    4문항짜리 세션이 커밋되는 일이 원천적으로 불가능하다.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION study_session_items_check_count()
RETURNS TRIGGER AS $$
DECLARE
  target_session uuid;
  item_count integer;
BEGIN
  target_session := COALESCE(NEW.session_id, OLD.session_id);

  -- 세션이 이미 지워졌으면(cascade 삭제) 검사할 필요가 없다.
  IF NOT EXISTS (SELECT 1 FROM study_sessions WHERE id = target_session) THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO item_count
  FROM study_session_items
  WHERE session_id = target_session;

  IF item_count <> 5 THEN
    RAISE EXCEPTION 'study session % must have exactly 5 items (found %)',
      target_session, item_count
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER study_session_items_count
  AFTER INSERT OR UPDATE OR DELETE ON study_session_items
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION study_session_items_check_count();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. 취약 영역 조회용 식 인덱스 (07 §2 슬롯 2, 07 §3)
--    smoothed_accuracy = (correct_count + 2) / (seen_count + 4)
--    seen_count >= 5 인 영역만 취약 판정 대상이다.
-- ---------------------------------------------------------------------------
CREATE INDEX mastery_weak_area_idx
  ON mastery (user_id, ((correct_count + 2.0) / (seen_count + 4.0)))
  WHERE seen_count >= 5;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. 최근 학습 이력 조회 (07 §2 슬롯 3 "최근 30일 미노출", 09 §5)
-- ---------------------------------------------------------------------------
CREATE INDEX study_sessions_user_recent_idx
  ON study_sessions (user_id, study_date DESC);
