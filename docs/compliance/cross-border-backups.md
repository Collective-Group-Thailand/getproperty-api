# Cross-border backup copies and PDPA s.28 (D-243, resolves O-016)

> **สถานะ: ⚖ รอทีมกฎหมายลงนามรับรองถ้อยคำ (pending legal sign-off)** — the technical facts below are decided and
> implemented (founder decision 2026-10-22, collective-infra commit "DLM cross-region copy … ap-northeast-1"); the DPA
> clause and privacy-notice wording in §4 are drafts for counsel. Owner of this page: getproperty-api; related:
> D-025 (PDPA), D-148 (PII encryption), D-233 (data safety mapped onto the platform), `docs/platform-blueprint.md`
> § Data safety, RUNBOOK §9.

## 1. What leaves Thailand

| Copy | Where | Content | Retention | Protection |
|---|---|---|---|---|
| Primary database, files, logs | AWS `ap-southeast-7` (Bangkok) | everything | per retention policy | EBS / S3 encryption at rest, TLS, RLS, per-tenant DEK for PII columns |
| pgBackRest (full Sun, diff daily, WAL ≤ 5 min) | S3 `collective-<env>-backups`, `ap-southeast-7` | the database | 35 days | SSE, private bucket |
| **Daily EBS snapshot of the prod data volume — cross-region copy** | **AWS `ap-northeast-1` (Tokyo)** | the whole data volume (PostgreSQL incl. every tenant's personal data, Valkey and EMQX state) | **7 days** | **encrypted** with the destination region's EBS key (or a customer-managed key, `snapshot_copy_kms_key_arn`); copies only, never mounted outside a restore |

Only the prod environment copies cross-region; UAT holds no production personal data.

**Why Tokyo**: locked decision 1 rules out Singapore and any non-AWS provider; Thailand has one AWS region, so the
locked requirement of a cross-region copy (decision 6) means a transfer abroad. `ap-northeast-1` is the nearest region
under a comprehensive data-protection law with an independent regulator (Japan's Act on the Protection of Personal
Information, PPC) recognised as adequate by the EU and the UK — the strongest available footing for the PDPA s.28
"adequate standard" assessment. (Alternatives considered: Jakarta, Kuala Lumpur — weaker or newer regimes; Sydney,
Mumbai — farther, no stronger basis.)

Personal data in the copy is partly also field-encrypted with each tenant's data key (national id / passport numbers,
bank accounts, PINs, provider credentials — D-148, D-240), whose key-encryption key does not travel with the snapshot.

## 2. Roles

- **Controller**: the building owner / operator — the getproperty tenant — for its residents', lessees' and staff's
  data (D-025). Collective Group (Thailand) is controller only for platform-level data (its own customers' contact
  persons, platform invoices).
- **Processor**: Collective Group (Thailand), running getproperty for the tenant.
- **Sub-processor**: Amazon Web Services (Thailand / Japan regions) — infrastructure only, no access to the content
  beyond what operating the encrypted storage requires.

## 3. Legal basis of the transfer (PDPA s.28 / s.29)

1. **Primary — s.28**: the destination country has an adequate personal-data-protection standard, assessed against
   the PDPC's criteria for cross-border transfers (Notification on the criteria for the protection of personal data
   sent or transferred abroad under s.28, 2023): Japan has a comprehensive statute (APPI), an independent supervisory
   authority, data-subject rights, enforcement and onward-transfer restrictions. ⚖ Counsel confirms whether a PDPC
   adequacy list or the controller's own assessment is relied on, and records the assessment.
2. **Fallback — s.29 appropriate safeguards**: the AWS Data Processing Addendum (standard contractual clauses for
   transfers, security measures, sub-processor terms) between Collective and AWS, plus the processor clause in
   Collective's DPA with each tenant (§4), meet the PDPC's notification on appropriate safeguards (contractual clauses).
3. No reliance on data-subject consent for the backup copy (consent can be withdrawn; backups cannot be selectively
   re-made).

## 4. Draft wording (⚖ for legal sign-off)

**Tenant DPA — sub-processing and transfers clause (draft):**
> The Processor stores encrypted backup copies of the Controller's personal data with its infrastructure sub-processor
> Amazon Web Services in the Kingdom of Thailand (primary) and, for disaster recovery only, as an encrypted daily
> snapshot retained for no more than seven (7) days in Japan (AWS Asia Pacific (Tokyo) region). The Processor relies on
> section 28 of the Personal Data Protection Act B.E. 2562 (the destination's adequate protection standard) and, in
> addition, on appropriate safeguards under section 29 (the sub-processor's data processing terms including standard
> contractual clauses). Backup copies are not accessed except to restore the service; data erased at the Controller's
> instruction disappears from every backup copy within thirty-five (35) days.

**Privacy notice (template for tenants, Thai + English, draft):**
> ข้อมูลของท่านจัดเก็บบนระบบคลาวด์ในประเทศไทย และมีสำเนาสำรองที่เข้ารหัสเก็บไว้ในประเทศญี่ปุ่นไม่เกิน 7 วันเพื่อการกู้คืนระบบเท่านั้น
> ภายใต้มาตรฐานการคุ้มครองข้อมูลส่วนบุคคลที่เพียงพอตามมาตรา 28 แห่ง พ.ร.บ. คุ้มครองข้อมูลส่วนบุคคล พ.ศ. 2562 —
> Your data is stored in the cloud in Thailand; an encrypted disaster-recovery copy is kept in Japan for at most 7 days,
> relying on the adequate protection standard under section 28 of the PDPA.

## 5. Erasure, restore and records

- Erasure / anonymisation (DSR) is applied in the primary database at once and reaches the cross-region copy within
  **7 days** and every backup within **35 days** (pgBackRest window) — D-233. After **any** restore, DSR erasures done
  after the restore point are re-applied before the service reopens (RUNBOOK §9).
- The restore drill restores from the primary-region backups; the cross-region copy is restored only in a regional
  disaster, by the platform engineer under the incident process.
- Records of processing (PDPA s.39 / s.40): the cross-border copy, its destination, retention and basis are listed in
  Collective's record of processing activities; this page is the technical annex.

## 6. Open items (⚖)

- Counsel signs off §3 and the §4 wording; the tenant DPA template and privacy-notice templates are updated with it
  (LAUNCH-CHECKLIST §1).
- Confirm whether the PDPC publishes an adequacy list that includes Japan by the pilot date; otherwise record the s.28
  assessment (or rely on s.29) in writing.
