/**
 * Jabiru Ventures — AI Report Generator
 * Task 5: Inspection Report Backend
 *
 * This Supabase Edge Function:
 * 1. Receives the inspection payload from checklist.html right after it's
 *    saved (same shape as the `inspections` row: job_id, scores, sections)
 * 2. Fetches job + property + customer details from Supabase
 * 3. Builds the same prompt/JSON schema report-review.html's client-side
 *    fallback already uses, and sends it to Claude
 * 4. Saves the draft into `inspections.report_draft` for that job, so it's
 *    already waiting when the owner opens report-review.html
 *
 * No WhatsApp notification is sent here — no Meta WhatsApp Business API is
 * used anywhere in this project. The owner checks report-review.html for
 * pending drafts.
 *
 * Expected POST body (same fields checklist.html already builds via
 * buildPayload() before inserting into `inspections`):
 * {
 *   "job_id": "uuid-of-the-job",
 *   "inspection_score": 82,
 *   "critical_count": 1,
 *   "major_count": 2,
 *   "minor_count": 4,
 *   "overall_remarks": "Property is generally in good condition",
 *   "sections": [
 *     { "section": "Exterior", "area": "Front Wall", "condition": "Fair",
 *       "defects": [ { "severity": "Major", "description": "Hairline crack near window" } ],
 *       "notes": "..." }
 *   ]
 * }
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

// ── ENV VARIABLES ─────────────────────────────────────────────────────────────
const SB_URL = Deno.env.get("SB_URL")!;
const SB_SERVICE_ROLE_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY")!;
const CLAUDE_API_KEY = Deno.env.get("CLAUDE_API_KEY")!;

// ── HELPERS ───────────────────────────────────────────────────────────────────

/**
 * Fetch full job details including customer and property
 */
async function fetchJobDetails(jobId: string): Promise<any> {
  const res = await fetch(
    `${SB_URL}/rest/v1/jobs?id=eq.${jobId}&select=*,customers(*),properties(*)&limit=1`,
    {
      headers: {
        apikey: SB_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SB_SERVICE_ROLE_KEY}`,
      },
    }
  );

  if (!res.ok) throw new Error("Failed to fetch job details");

  const rows = await res.json();
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Same flattening logic report-review.html uses client-side
 * (extractDefectsFromSections) — kept identical so both paths produce the
 * same shape regardless of which one ends up generating the draft first.
 */
function extractDefects(sections: any[]): any[] {
  if (!sections) return [];
  const defects: any[] = [];
  for (const sec of sections) {
    for (const d of sec.defects || []) {
      defects.push({ area: sec.area, severity: d.severity, description: d.description, room: sec.section });
    }
  }
  return defects;
}

/**
 * Build the exact same prompt/JSON-schema request report-review.html's
 * client-side buildReportPrompt() uses, so report_draft is always in the
 * shape the review UI expects: {summary, executive, recommendations_text}
 */
function buildReportPrompt(job: any, payload: any): string {
  const defects = extractDefects(payload.sections);
  return `You are a professional building inspector writing a formal inspection report for Jabiru Ventures, a Malaysian BEM-certified inspection company.

Property: ${job.properties?.address || "Unknown"}
Client: ${job.customers?.full_name || "Unknown"}
Score: ${payload.inspection_score}/100
Critical defects: ${payload.critical_count}, Major: ${payload.major_count}, Minor: ${payload.minor_count}
Defects: ${JSON.stringify(defects.slice(0, 10))}
Inspector notes: ${payload.overall_remarks || "None"}

Write a professional inspection report. Respond ONLY with valid JSON in this exact format, no markdown, no preamble:
{"summary":"3 paragraph summary...","executive":"2 paragraph executive summary...","recommendations_text":"numbered recommendations as a single string with newlines"}`;
}

/**
 * Call Claude API to generate the inspection report draft
 */
async function generateReportWithClaude(prompt: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": CLAUDE_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error: ${res.status} — ${err}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text || "";
  return text.replace(/```json|```/g, "").trim();
}

/**
 * Save the report draft into the `inspections` row for this job — this is
 * the same table/column report-review.html reads from and writes to
 * (ins.report_draft), NOT a separate `reports` table.
 */
async function saveReportDraft(jobId: string, reportDraftJson: string): Promise<void> {
  const res = await fetch(`${SB_URL}/rest/v1/inspections?job_id=eq.${jobId}`, {
    method: "PATCH",
    headers: {
      apikey: SB_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SB_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ report_draft: reportDraftJson }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to save report draft: ${err}`);
  }
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // ── Parse request body ───────────────────────────────────────────────────
  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON body" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const { job_id } = body;

  if (!job_id) {
    return new Response(
      JSON.stringify({ error: "job_id is required" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  console.log(`[Jabiru] 📋 Generating report draft for job: ${job_id}`);

  // ── Step 1: Fetch job details ────────────────────────────────────────────
  let job: any;
  try {
    job = await fetchJobDetails(job_id);
    if (!job) {
      return new Response(
        JSON.stringify({ error: "Job not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }
    console.log(`[Jabiru] ✅ Job fetched: ${job.invoice_no}`);
  } catch (err) {
    console.error("[Jabiru] ❌ Failed to fetch job:", err);
    return new Response(
      JSON.stringify({ error: "Failed to fetch job details" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  // ── Step 2: Generate report draft with Claude ────────────────────────────
  let reportDraftJson: string;
  try {
    const prompt = buildReportPrompt(job, body);
    reportDraftJson = await generateReportWithClaude(prompt);
    // Sanity-check it's actually valid JSON before saving
    JSON.parse(reportDraftJson);
    console.log("[Jabiru] ✅ Report draft generated by Claude");
  } catch (err) {
    console.error("[Jabiru] ❌ Claude report generation failed:", err);
    return new Response(
      JSON.stringify({ error: "Failed to generate report draft" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  // ── Step 3: Save draft into the inspections row for this job ────────────
  try {
    await saveReportDraft(job_id, reportDraftJson);
    console.log("[Jabiru] ✅ Report draft saved to inspections.report_draft");
  } catch (err) {
    console.error("[Jabiru] ❌ Failed to save report draft:", err);
    return new Response(
      JSON.stringify({ error: "Failed to save report draft" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({
      success: true,
      job_id: job_id,
      invoice_no: job.invoice_no,
      message: "Report draft generated and saved successfully",
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
});
