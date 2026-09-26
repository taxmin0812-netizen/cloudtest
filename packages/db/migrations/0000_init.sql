CREATE TABLE "account_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"is_fixed_asset" boolean DEFAULT false NOT NULL,
	"vat_non_deductible_hint" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"period" text NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"acknowledged_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"actor_name" text NOT NULL,
	"action" text NOT NULL,
	"category" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"client_id" uuid,
	"summary" text NOT NULL,
	"before_data" jsonb,
	"after_data" jsonb,
	"revertible" boolean DEFAULT false NOT NULL,
	"reverted_by_id" uuid,
	"revert_of_id" uuid,
	"ip" text,
	"user_agent" text,
	"session_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "classification_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"merchant_key" text NOT NULL,
	"merchant_business_number" text,
	"field" text NOT NULL,
	"before_value" text,
	"before_label" text,
	"after_value" text NOT NULL,
	"after_label" text,
	"before_source" text,
	"before_confidence" integer,
	"reason" text,
	"user_id" uuid,
	"suggested_rule_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "classification_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"engine_version" text NOT NULL,
	"account" jsonb NOT NULL,
	"vat" jsonb NOT NULL,
	"risks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"review_level" text NOT NULL,
	"batch_job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_business_profiles" (
	"client_id" uuid PRIMARY KEY NOT NULL,
	"industry" text NOT NULL,
	"industry_code" text,
	"industry_name" text,
	"vat_type" text NOT NULL,
	"deemed_input_tax_eligible" boolean DEFAULT false NOT NULL,
	"non_deductible_vehicles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"business_cards" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rule_params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"withholding_semiannual" boolean DEFAULT false NOT NULL,
	"fiscal_year_start_month" integer DEFAULT 1 NOT NULL,
	"notes" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"business_number" text NOT NULL,
	"representative_name" text,
	"business_type" text NOT NULL,
	"assignee_id" uuid,
	"wehago_company_code" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"name" text NOT NULL,
	"income_type" text NOT NULL,
	"id_number_enc" text,
	"id_number_hash" text,
	"id_number_masked" text,
	"is_foreigner" boolean DEFAULT false NOT NULL,
	"hire_date" date,
	"resign_date" date,
	"base_salary" bigint DEFAULT 0 NOT NULL,
	"allowances" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"non_taxable" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"daily_wage" bigint,
	"business_income_code" text,
	"payment_day" integer,
	"bank_name" text,
	"bank_account_enc" text,
	"bank_account_masked" text,
	"dependents" integer DEFAULT 1 NOT NULL,
	"report_status" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "export_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"export_job_id" uuid NOT NULL,
	"transaction_id" uuid,
	"row_number" integer NOT NULL,
	"supply_amount" bigint NOT NULL,
	"vat_amount" bigint NOT NULL,
	"total_amount" bigint NOT NULL,
	"account_code" text
);
--> statement-breakpoint
CREATE TABLE "export_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"period" text NOT NULL,
	"kind" text NOT NULL,
	"template_key" text NOT NULL,
	"template_version" text NOT NULL,
	"status" text NOT NULL,
	"file_id" uuid,
	"validation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"supply_amount" bigint DEFAULT 0 NOT NULL,
	"vat_amount" bigint DEFAULT 0 NOT NULL,
	"total_amount" bigint DEFAULT 0 NOT NULL,
	"blocked_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"downloaded_at" timestamp with time zone,
	"upload_confirmed_at" timestamp with time zone,
	"upload_confirmed_by" uuid
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"storage_key" text NOT NULL,
	"original_name" text NOT NULL,
	"mime_type" text,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"encrypted" boolean DEFAULT true NOT NULL,
	"purpose" text NOT NULL,
	"client_id" uuid,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "filing_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"period" text NOT NULL,
	"kind" text NOT NULL,
	"steps" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"current_step" text NOT NULL,
	"due_date" date,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"channel_status" text DEFAULT 'FILE_BASED' NOT NULL,
	"assignee_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "filing_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"filing_job_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"file_id" uuid,
	"receipt_number" text,
	"amount" bigint,
	"filed_at" timestamp with time zone,
	"collected_via" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid,
	"file_id" uuid,
	"channel" text NOT NULL,
	"format_profile" text,
	"source" text NOT NULL,
	"period" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"imported_rows" integer DEFAULT 0 NOT NULL,
	"duplicate_rows" integer DEFAULT 0 NOT NULL,
	"failed_rows" integer DEFAULT 0 NOT NULL,
	"source_supply_amount" bigint DEFAULT 0 NOT NULL,
	"source_vat_amount" bigint DEFAULT 0 NOT NULL,
	"source_total_amount" bigint DEFAULT 0 NOT NULL,
	"message" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "integration_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"status_reason" text NOT NULL,
	"config_enc" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"error_message" text,
	"progress" real DEFAULT 0 NOT NULL,
	"total_items" integer DEFAULT 0 NOT NULL,
	"processed_items" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_by" text,
	"locked_at" timestamp with time zone,
	"parent_job_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "login_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"email" text NOT NULL,
	"success" boolean NOT NULL,
	"result" text NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mapping_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid,
	"name" text NOT NULL,
	"condition" jsonb NOT NULL,
	"account_code" text NOT NULL,
	"account_name" text NOT NULL,
	"vat_override" jsonb,
	"confidence" integer DEFAULT 99 NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"status" text NOT NULL,
	"origin" text NOT NULL,
	"suggestion_reason" text,
	"applied_count" integer DEFAULT 0 NOT NULL,
	"last_applied_at" timestamp with time zone,
	"created_by" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"client_id" uuid,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"href" text,
	"dedupe_key" text,
	"read_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payroll_month_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"income_type" text NOT NULL,
	"taxable_pay" bigint NOT NULL,
	"non_taxable_pay" bigint DEFAULT 0 NOT NULL,
	"gross_pay" bigint NOT NULL,
	"allowances" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"work_days" integer,
	"income_tax" bigint DEFAULT 0 NOT NULL,
	"local_income_tax" bigint DEFAULT 0 NOT NULL,
	"other_deductions" bigint DEFAULT 0 NOT NULL,
	"net_pay" bigint DEFAULT 0 NOT NULL,
	"payment_date" date,
	"change_kinds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"needs_review" boolean DEFAULT false NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"origin" text DEFAULT 'carried_forward' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_months" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"period" text NOT NULL,
	"payment_period" text NOT NULL,
	"wizard_step" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"diff_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"totals" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconciliation_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"period" text NOT NULL,
	"export_job_id" uuid,
	"phase" text NOT NULL,
	"balanced" boolean NOT NULL,
	"export_allowed" boolean NOT NULL,
	"report" jsonb NOT NULL,
	"summary" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"condition" jsonb,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"bucket" text NOT NULL,
	"severity" text NOT NULL,
	"blocks_auto_approval" boolean DEFAULT true NOT NULL,
	"message_template" text NOT NULL,
	"client_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"applied_count" integer DEFAULT 0 NOT NULL,
	"last_applied_at" timestamp with time zone,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_rules_code_client_uq" UNIQUE NULLS NOT DISTINCT("code","client_id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"ip" text,
	"user_agent" text,
	"mfa_verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_errors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fingerprint" text NOT NULL,
	"area" text NOT NULL,
	"message" text NOT NULL,
	"user_message" text,
	"stack" text,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"loop_status" text DEFAULT 'new' NOT NULL,
	"root_cause" text,
	"fix_proposal" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid,
	"period" text NOT NULL,
	"total_transactions" integer DEFAULT 0 NOT NULL,
	"auto_approved" integer DEFAULT 0 NOT NULL,
	"no_touch" integer DEFAULT 0 NOT NULL,
	"reviewed" integer DEFAULT 0 NOT NULL,
	"corrected" integer DEFAULT 0 NOT NULL,
	"exceptions" integer DEFAULT 0 NOT NULL,
	"manual_touches" integer DEFAULT 0 NOT NULL,
	"payroll_manual_touches" integer DEFAULT 0 NOT NULL,
	"recon_errors" integer DEFAULT 0 NOT NULL,
	"processing_seconds" integer DEFAULT 0 NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transaction_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_job_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"raw_data" jsonb NOT NULL,
	"outcome" text NOT NULL,
	"error_reason" text,
	"error_field" text,
	"transaction_id" uuid,
	"supply_amount" bigint,
	"vat_amount" bigint,
	"total_amount" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"business_number" text NOT NULL,
	"import_job_id" uuid,
	"source" text NOT NULL,
	"channel" text NOT NULL,
	"direction" text NOT NULL,
	"period" text NOT NULL,
	"transaction_date" date NOT NULL,
	"evidence_type" text NOT NULL,
	"merchant_name" text NOT NULL,
	"merchant_key" text NOT NULL,
	"merchant_business_number" text,
	"merchant_category" text,
	"merchant_tax_type" text DEFAULT 'unknown' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"supply_amount" bigint NOT NULL,
	"vat_amount" bigint NOT NULL,
	"service_charge" bigint DEFAULT 0 NOT NULL,
	"total_amount" bigint NOT NULL,
	"card_number_masked" text,
	"approval_number" text,
	"invoice_number" text,
	"original_source_id" text,
	"currency" text DEFAULT 'KRW' NOT NULL,
	"is_foreign" boolean DEFAULT false NOT NULL,
	"source_deductible_hint" boolean,
	"raw_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"duplicate_of_id" uuid,
	"duplicate_reason" text,
	"account_code" text,
	"account_name" text,
	"account_confidence" integer,
	"classification_source" text,
	"classification_summary" text,
	"vat_type" text,
	"deductible" boolean,
	"vat_confidence" integer,
	"vat_reason_code" text,
	"confidence_score" integer,
	"review_level" text,
	"buckets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"risk_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'imported' NOT NULL,
	"touch_count" integer DEFAULT 0 NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"excluded_reason" text,
	"export_job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'staff' NOT NULL,
	"mfa_enabled" boolean DEFAULT false NOT NULL,
	"mfa_secret_enc" text,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"allowed_ip_ranges" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"password_changed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vat_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"condition" jsonb NOT NULL,
	"outcome" text NOT NULL,
	"reason_text" text NOT NULL,
	"legal_basis" text,
	"confidence" integer DEFAULT 90 NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"client_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"applied_count" integer DEFAULT 0 NOT NULL,
	"last_applied_at" timestamp with time zone,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vat_rules_code_client_uq" UNIQUE NULLS NOT DISTINCT("code","client_id")
);
--> statement-breakpoint
ALTER TABLE "ai_reviews" ADD CONSTRAINT "ai_reviews_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_reviews" ADD CONSTRAINT "ai_reviews_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classification_corrections" ADD CONSTRAINT "classification_corrections_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classification_corrections" ADD CONSTRAINT "classification_corrections_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classification_corrections" ADD CONSTRAINT "classification_corrections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classification_results" ADD CONSTRAINT "classification_results_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_business_profiles" ADD CONSTRAINT "client_business_profiles_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_items" ADD CONSTRAINT "export_items_export_job_id_export_jobs_id_fk" FOREIGN KEY ("export_job_id") REFERENCES "public"."export_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_items" ADD CONSTRAINT "export_items_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_upload_confirmed_by_users_id_fk" FOREIGN KEY ("upload_confirmed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "filing_jobs" ADD CONSTRAINT "filing_jobs_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "filing_jobs" ADD CONSTRAINT "filing_jobs_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "filing_results" ADD CONSTRAINT "filing_results_filing_job_id_filing_jobs_id_fk" FOREIGN KEY ("filing_job_id") REFERENCES "public"."filing_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "filing_results" ADD CONSTRAINT "filing_results_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login_history" ADD CONSTRAINT "login_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mapping_rules" ADD CONSTRAINT "mapping_rules_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mapping_rules" ADD CONSTRAINT "mapping_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mapping_rules" ADD CONSTRAINT "mapping_rules_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_items" ADD CONSTRAINT "payroll_items_payroll_month_id_payroll_months_id_fk" FOREIGN KEY ("payroll_month_id") REFERENCES "public"."payroll_months"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_items" ADD CONSTRAINT "payroll_items_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_items" ADD CONSTRAINT "payroll_items_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_months" ADD CONSTRAINT "payroll_months_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_months" ADD CONSTRAINT "payroll_months_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_jobs" ADD CONSTRAINT "reconciliation_jobs_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_jobs" ADD CONSTRAINT "reconciliation_jobs_export_job_id_export_jobs_id_fk" FOREIGN KEY ("export_job_id") REFERENCES "public"."export_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_jobs" ADD CONSTRAINT "reconciliation_jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_rules" ADD CONSTRAINT "review_rules_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_rules" ADD CONSTRAINT "review_rules_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_metrics" ADD CONSTRAINT "system_metrics_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_sources" ADD CONSTRAINT "transaction_sources_import_job_id_import_jobs_id_fk" FOREIGN KEY ("import_job_id") REFERENCES "public"."import_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_import_job_id_import_jobs_id_fk" FOREIGN KEY ("import_job_id") REFERENCES "public"."import_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vat_rules" ADD CONSTRAINT "vat_rules_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vat_rules" ADD CONSTRAINT "vat_rules_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_codes_code_uq" ON "account_codes" USING btree ("code");--> statement-breakpoint
CREATE INDEX "ai_reviews_client_period_idx" ON "ai_reviews" USING btree ("client_id","period","kind");--> statement-breakpoint
CREATE INDEX "audit_created_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_client_idx" ON "audit_logs" USING btree ("client_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_actor_idx" ON "audit_logs" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE INDEX "corrections_client_merchant_idx" ON "classification_corrections" USING btree ("client_id","merchant_key","field");--> statement-breakpoint
CREATE INDEX "corrections_created_idx" ON "classification_corrections" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "classification_results_tx_idx" ON "classification_results" USING btree ("transaction_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "clients_code_uq" ON "clients" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "clients_bizno_uq" ON "clients" USING btree ("business_number");--> statement-breakpoint
CREATE INDEX "clients_assignee_idx" ON "clients" USING btree ("assignee_id");--> statement-breakpoint
CREATE INDEX "employees_client_idx" ON "employees" USING btree ("client_id","income_type");--> statement-breakpoint
CREATE INDEX "employees_idhash_idx" ON "employees" USING btree ("client_id","id_number_hash");--> statement-breakpoint
CREATE INDEX "export_items_job_idx" ON "export_items" USING btree ("export_job_id");--> statement-breakpoint
CREATE INDEX "export_items_tx_idx" ON "export_items" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "export_jobs_client_period_idx" ON "export_jobs" USING btree ("client_id","period","kind");--> statement-breakpoint
CREATE INDEX "files_sha_idx" ON "files" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "files_client_idx" ON "files" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "filing_jobs_client_period_kind_uq" ON "filing_jobs" USING btree ("client_id","period","kind");--> statement-breakpoint
CREATE INDEX "filing_results_job_idx" ON "filing_results" USING btree ("filing_job_id");--> statement-breakpoint
CREATE INDEX "import_jobs_client_idx" ON "import_jobs" USING btree ("client_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_connections_key_uq" ON "integration_connections" USING btree ("key");--> statement-breakpoint
CREATE INDEX "jobs_queue_idx" ON "jobs" USING btree ("status","run_after");--> statement-breakpoint
CREATE INDEX "jobs_parent_idx" ON "jobs" USING btree ("parent_job_id");--> statement-breakpoint
CREATE INDEX "jobs_created_idx" ON "jobs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "login_history_user_idx" ON "login_history" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "mapping_rules_client_idx" ON "mapping_rules" USING btree ("client_id","status","priority");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","read_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_uq" ON "notifications" USING btree ("dedupe_key") WHERE resolved_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_items_month_emp_uq" ON "payroll_items" USING btree ("payroll_month_id","employee_id");--> statement-breakpoint
CREATE INDEX "payroll_items_emp_idx" ON "payroll_items" USING btree ("employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_months_client_period_uq" ON "payroll_months" USING btree ("client_id","period");--> statement-breakpoint
CREATE INDEX "recon_client_period_idx" ON "reconciliation_jobs" USING btree ("client_id","period","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_uq" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "system_errors_fp_uq" ON "system_errors" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX "system_errors_last_idx" ON "system_errors" USING btree ("last_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "system_metrics_client_period_uq" ON "system_metrics" USING btree ("client_id","period");--> statement-breakpoint
CREATE INDEX "transaction_sources_job_idx" ON "transaction_sources" USING btree ("import_job_id","row_number");--> statement-breakpoint
CREATE INDEX "transaction_sources_tx_idx" ON "transaction_sources" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "tx_client_period_idx" ON "transactions" USING btree ("client_id","period","status");--> statement-breakpoint
CREATE INDEX "tx_client_date_idx" ON "transactions" USING btree ("client_id","transaction_date");--> statement-breakpoint
CREATE INDEX "tx_client_merchant_bizno_idx" ON "transactions" USING btree ("client_id","merchant_business_number");--> statement-breakpoint
CREATE INDEX "tx_client_merchant_key_idx" ON "transactions" USING btree ("client_id","merchant_key");--> statement-breakpoint
CREATE INDEX "tx_fingerprint_idx" ON "transactions" USING btree ("client_id","fingerprint");--> statement-breakpoint
CREATE INDEX "tx_status_idx" ON "transactions" USING btree ("status","period");--> statement-breakpoint
CREATE INDEX "tx_import_job_idx" ON "transactions" USING btree ("import_job_id");--> statement-breakpoint
CREATE INDEX "tx_export_job_idx" ON "transactions" USING btree ("export_job_id");--> statement-breakpoint
CREATE INDEX "tx_merchant_key_global_idx" ON "transactions" USING btree ("merchant_key");--> statement-breakpoint
CREATE INDEX "tx_buckets_gin" ON "transactions" USING gin ("buckets");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email");