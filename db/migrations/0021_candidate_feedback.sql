-- Fixed-purpose capability functions: public callers never receive table grants.
SET ROLE eureka_owner;
ALTER TABLE eureka.interview_feedback
 ADD COLUMN format text CHECK(length(format)<=80),
 ADD COLUMN topics text[] CHECK(cardinality(topics)<=20),
 ADD COLUMN difficult_questions text CHECK(length(difficult_questions)<=4000),
 ADD COLUMN duration_min integer CHECK(duration_min BETWEEN 0 AND 1440),
 ADD COLUMN next_step text CHECK(length(next_step)<=1000);
CREATE TABLE eureka.feedback_delivery (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), interview_id uuid NOT NULL REFERENCES eureka.interview(id),
 starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
 token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
 token_cipher text NOT NULL, expires_at timestamptz NOT NULL DEFAULT now()+interval '48 hours',
 used_at timestamptz, sent_at timestamptz,
 UNIQUE(interview_id, starts_at, ends_at)
);
ALTER TABLE eureka.feedback_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE eureka.feedback_delivery FORCE ROW LEVEL SECURITY;
CREATE POLICY feedback_owner ON eureka.feedback_delivery TO eureka_owner USING(true) WITH CHECK(true);
CREATE POLICY feedback_interview_owner ON eureka.interview FOR SELECT TO eureka_owner USING(true);
CREATE POLICY feedback_interview_owner_lock ON eureka.interview FOR UPDATE TO eureka_owner USING(true) WITH CHECK(true);
CREATE POLICY feedback_candidate_owner ON eureka.candidate FOR SELECT TO eureka_owner USING(true);
CREATE POLICY feedback_person_owner ON eureka.person FOR SELECT TO eureka_owner USING(true);
CREATE POLICY feedback_insert_owner ON eureka.interview_feedback FOR INSERT TO eureka_owner WITH CHECK(kind='candidate' AND author_id IS NULL);

CREATE TABLE eureka.feedback_notification (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), delivery_id uuid NOT NULL REFERENCES eureka.feedback_delivery(id),
 user_id uuid NOT NULL REFERENCES eureka.app_user(id), sent_at timestamptz, UNIQUE(delivery_id,user_id)
);
ALTER TABLE eureka.feedback_notification ENABLE ROW LEVEL SECURITY;
ALTER TABLE eureka.feedback_notification FORCE ROW LEVEL SECURITY;
CREATE POLICY feedback_notification_owner ON eureka.feedback_notification TO eureka_owner USING(true) WITH CHECK(true);
CREATE POLICY feedback_user_owner ON eureka.app_user FOR SELECT TO eureka_owner USING(true);
CREATE FUNCTION eureka.feedback_notification_due() RETURNS TABLE(id uuid) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT n.id FROM eureka.feedback_notification n WHERE n.sent_at IS NULL ORDER BY n.id LIMIT 100
$$;
CREATE FUNCTION eureka.feedback_notification_data(p_id uuid) RETURNS TABLE(email text) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT u.email::text FROM eureka.feedback_notification n JOIN eureka.app_user u ON u.id=n.user_id WHERE n.id=p_id AND n.sent_at IS NULL AND u.status='active' FOR UPDATE OF n
$$;
CREATE FUNCTION eureka.feedback_notification_sent(p_id uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 UPDATE eureka.feedback_notification SET sent_at=now() WHERE id=p_id AND sent_at IS NULL
$$;
REVOKE ALL ON FUNCTION eureka.feedback_notification_due(),eureka.feedback_notification_data(uuid),eureka.feedback_notification_sent(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eureka.feedback_notification_due(),eureka.feedback_notification_data(uuid),eureka.feedback_notification_sent(uuid) TO eureka_worker;
CREATE FUNCTION eureka.feedback_due() RETURNS TABLE(id uuid) LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp AS $$
 SELECT i.id FROM eureka.interview i JOIN eureka.candidate c ON c.id=i.candidate_id JOIN eureka.person p ON p.id=c.person_id
 WHERE i.ends_at <= now()-interval '60 minutes'
 AND i.call_status NOT IN ('cancelled','rescheduled','no_invite') AND p.personal_email IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM eureka.feedback_delivery d WHERE d.interview_id=i.id AND d.starts_at=i.starts_at AND d.ends_at=i.ends_at AND (d.sent_at IS NOT NULL OR d.used_at IS NOT NULL))
 ORDER BY i.ends_at LIMIT 100
$$;
CREATE FUNCTION eureka.feedback_prepare(p_id uuid,p_hash text,p_cipher text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp AS $$
DECLARE i record; result uuid;
BEGIN
 SELECT * INTO i FROM eureka.interview WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR i.ends_at>now()-interval '60 minutes' OR i.call_status IN ('cancelled','rescheduled','no_invite') THEN RETURN NULL; END IF;
 INSERT INTO eureka.feedback_delivery(interview_id,starts_at,ends_at,token_hash,token_cipher)
 VALUES(i.id,i.starts_at,i.ends_at,p_hash,p_cipher) ON CONFLICT(interview_id,starts_at,ends_at) DO UPDATE
 SET token_hash=EXCLUDED.token_hash,token_cipher=EXCLUDED.token_cipher,expires_at=now()+interval '48 hours'
 WHERE eureka.feedback_delivery.expires_at<=now() AND eureka.feedback_delivery.sent_at IS NULL AND eureka.feedback_delivery.used_at IS NULL;
 SELECT id INTO result FROM eureka.feedback_delivery WHERE interview_id=i.id AND starts_at=i.starts_at AND ends_at=i.ends_at;
 RETURN result;
END $$;
-- Called inside the send transaction: holds the interview row lock until delivery finishes.
CREATE FUNCTION eureka.feedback_send_data(p_id uuid) RETURNS TABLE(email text,cipher text) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp AS $$
DECLARE target uuid;
BEGIN
 SELECT interview_id INTO target FROM eureka.feedback_delivery WHERE id=p_id;
 PERFORM 1 FROM eureka.interview WHERE id=target FOR UPDATE;
 RETURN QUERY SELECT p.personal_email::text,d.token_cipher FROM eureka.feedback_delivery d
 JOIN eureka.interview i ON i.id=d.interview_id JOIN eureka.candidate c ON c.id=i.candidate_id JOIN eureka.person p ON p.id=c.person_id
 WHERE d.id=p_id AND d.sent_at IS NULL AND d.expires_at>now() AND d.starts_at=i.starts_at AND d.ends_at=i.ends_at
 AND i.ends_at<=now()-interval '60 minutes' AND i.call_status NOT IN ('cancelled','rescheduled','no_invite') AND p.personal_email IS NOT NULL;
END $$;
CREATE FUNCTION eureka.feedback_sent(p_id uuid) RETURNS void LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp AS $$ UPDATE eureka.feedback_delivery SET sent_at=now(),token_cipher='' WHERE id=p_id AND sent_at IS NULL $$;
CREATE FUNCTION eureka.feedback_view(p_hash text) RETURNS TABLE(first_name text,client_name text,starts_at timestamptz,expires_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT p.first_name,cl.name,i.starts_at,d.expires_at FROM eureka.feedback_delivery d
 JOIN eureka.interview i ON i.id=d.interview_id JOIN eureka.candidate c ON c.id=i.candidate_id
 JOIN eureka.person p ON p.id=c.person_id LEFT JOIN eureka.client cl ON cl.id=i.client_id
 WHERE d.token_hash=p_hash AND d.used_at IS NULL AND d.expires_at>now()
 AND d.starts_at=i.starts_at AND d.ends_at=i.ends_at AND i.call_status NOT IN ('cancelled','rescheduled','no_invite')
$$;
CREATE FUNCTION eureka.feedback_submit(p_hash text,p_rating integer,p_notes text,p_details jsonb DEFAULT '{}'::jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE target uuid; d record;
BEGIN
 IF p_rating IS NULL OR p_rating NOT BETWEEN 1 AND 5 OR length(p_notes)>4000 THEN RAISE EXCEPTION 'invalid_feedback' USING ERRCODE='check_violation'; END IF;
 SELECT interview_id INTO target FROM eureka.feedback_delivery WHERE token_hash=p_hash;
 PERFORM 1 FROM eureka.interview WHERE id=target FOR UPDATE;
 SELECT * INTO d FROM eureka.feedback_delivery WHERE token_hash=p_hash FOR UPDATE;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM eureka.feedback_view(p_hash)) THEN RETURN false; END IF;
 INSERT INTO eureka.interview_feedback(interview_id,author_id,kind,rating,notes,format,topics,difficult_questions,duration_min,next_step)
 VALUES(d.interview_id,NULL,'candidate',p_rating,p_notes,p_details->>'format',
 ARRAY(SELECT jsonb_array_elements_text(p_details->'topics')),p_details->>'difficultQuestions',(p_details->>'durationMin')::integer,p_details->>'nextStep');
 UPDATE eureka.feedback_delivery SET used_at=now(),token_cipher='' WHERE id=d.id;
 INSERT INTO eureka.feedback_notification(delivery_id,user_id)
 SELECT d.id,recipient FROM eureka.interview i CROSS JOIN LATERAL unnest(ARRAY[i.recruiter_id,i.coach_id]) recipient
 WHERE i.id=d.interview_id AND recipient IS NOT NULL ON CONFLICT DO NOTHING;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION eureka.feedback_due(),eureka.feedback_prepare(uuid,text,text),eureka.feedback_send_data(uuid),eureka.feedback_sent(uuid),eureka.feedback_view(text),eureka.feedback_submit(text,integer,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION eureka.feedback_due(),eureka.feedback_prepare(uuid,text,text),eureka.feedback_send_data(uuid),eureka.feedback_sent(uuid) TO eureka_worker;
GRANT EXECUTE ON FUNCTION eureka.feedback_view(text),eureka.feedback_submit(text,integer,text,jsonb) TO eureka_app;
RESET ROLE;
