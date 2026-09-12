/**
 * Jabiru Ventures — Invoice PDF Generator
 * Task 3: Milestone Invoice Generation + Send
 *
 * This Supabase Edge Function:
 * 1. Receives a manual trigger with job_id + milestone + amount
 * 2. Fetches job/customer/property details from Supabase
 * 3. Generates a branded PDF invoice for that milestone only
 * 4. Sends the PDF to client via Email (Gmail SMTP)
 * 5. Logs the invoice in Supabase (invoices table)
 *
 * WhatsApp delivery is intentionally NOT automated here — no Meta WhatsApp
 * Business API is used anywhere in this project. The response includes the
 * public PDF URL so the CRM can offer the owner a manual "open WhatsApp"
 * share action instead.
 *
 * Expected POST body:
 * {
 *   "job_id": "uuid-of-the-job",
 *   "milestone": "deposit" | "completion" | "final",
 *   "amount": 1500.00
 * }
 *
 * Milestone labels:
 * - deposit    -> "Deposit Payment (50%)"
 * - completion -> "Completion Payment (30%)"
 * - final      -> "Final Payment (20%) - Upon Report Submission"
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
import { PDFDocument, rgb, StandardFonts } from "https://esm.sh/pdf-lib@1.17.1";

// ── ENV VARIABLES ─────────────────────────────────────────────────────────────
const SB_URL = Deno.env.get("SB_URL")!;
const SB_SERVICE_ROLE_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY")!;
const GMAIL_APP_PASSWORD = Deno.env.get("GMAIL_APP_PASSWORD")!;
const GMAIL_SENDER_EMAIL = Deno.env.get("GMAIL_SENDER_EMAIL")!;

// How long an invoice share link stays valid (30 days) — long enough for
// a client to pay, short enough that a leaked link expires.
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 30;

// ── COMPANY CONSTANTS ─────────────────────────────────────────────────────────
const COMPANY = {
  name: "Jabiru Ventures",
  ssm: "202303027559 (003464550-H)",
  addressLine1: "T1-21-18, Bayu Residensi @SeriTemenggung, Jln Temenggung,",
  addressLine2: "68100 Batu Caves, Selangor",
  phone: "60149420756",
  email: "admin@jabiru-ventures.com",
  website: "https://jabiru-ventures.com/",
  bankName: "CIMB Bank",
  bankAccountName: "Jabiru Ventures",
  bankAccountNo: "8011050793",
};

// Brand colours (RGB 0-1 scale for pdf-lib)
const COLOR_NAVY = rgb(0.035, 0.239, 0.447); // #093D72
const COLOR_BLUE = rgb(0.078, 0.467, 0.776); // #1477C6
const COLOR_LIGHT_BLUE = rgb(0.922, 0.957, 0.992); // #EBF4FD
const COLOR_WHITE = rgb(1, 1, 1);
const COLOR_BLACK = rgb(0.1, 0.1, 0.1);
const COLOR_GREY = rgb(0.4, 0.4, 0.4);

const MILESTONE_LABELS: Record<string, string> = {
  deposit: "Deposit Payment (50%)",
  completion: "Completion Payment (30%)",
  final: "Final Payment (20%) - Upon Report Submission",
};

// ── HELPERS ───────────────────────────────────────────────────────────────────

function formatDate(date: Date = new Date()): string {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
}

function formatCurrency(amount: number): string {
  return `RM ${amount.toFixed(2)}`;
}

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
 * Count how many invoices already exist for this job, to generate a
 * sub-reference like JV-2025-0001-D (Deposit), -C (Completion), -F (Final)
 */
function getMilestoneSuffix(milestone: string): string {
  if (milestone === "deposit") return "D";
  if (milestone === "completion") return "C";
  if (milestone === "final") return "F";
  return "X";
}

/**
 * Log the invoice in Supabase invoices table
 */
async function logInvoice(
  jobId: string,
  milestone: string,
  amount: number,
  invoiceRef: string
): Promise<void> {
  const res = await fetch(`${SB_URL}/rest/v1/invoices`, {
    method: "POST",
    headers: {
      apikey: SB_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SB_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      job_id: jobId,
      milestone: milestone,
      amount: amount,
      invoice_ref: invoiceRef,
      sent_at: new Date().toISOString(),
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("[Jabiru] ⚠️ Failed to log invoice (non-fatal):", err);
  }
}

/**
 * Generate the branded PDF invoice for a single milestone.
 * Returns the PDF as a Uint8Array.
 */
async function generateInvoicePdf(
  job: any,
  milestone: string,
  amount: number,
  invoiceRef: string
): Promise<Uint8Array> {
  const customer = job.customers;
  const property = job.properties;

  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595.28, 841.89]); // A4 size in points
  const { width, height } = page.getSize();

  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  let y = height; // cursor, starts at top

  // ── HEADER BAR (navy background) ───────────────────────────────────────
  const headerHeight = 100;
  page.drawRectangle({
    x: 0,
    y: height - headerHeight,
    width: width,
    height: headerHeight,
    color: COLOR_NAVY,
  });

  page.drawText(COMPANY.name, {
    x: 40,
    y: height - 45,
    size: 22,
    font: fontBold,
    color: COLOR_WHITE,
  });

  page.drawText("BEM-Certified Property Inspectors", {
    x: 40,
    y: height - 65,
    size: 10,
    font: fontRegular,
    color: COLOR_LIGHT_BLUE,
  });

  page.drawText("INVOICE", {
    x: width - 150,
    y: height - 45,
    size: 20,
    font: fontBold,
    color: COLOR_WHITE,
  });

  page.drawText(invoiceRef, {
    x: width - 150,
    y: height - 65,
    size: 11,
    font: fontRegular,
    color: COLOR_LIGHT_BLUE,
  });

  y = height - headerHeight - 30;

  // ── COMPANY DETAILS (left) ───────────────────────────────────────────────
  page.drawText(COMPANY.name, { x: 40, y, size: 9, font: fontBold, color: COLOR_BLACK });
  y -= 12;
  page.drawText(`SSM: ${COMPANY.ssm}`, { x: 40, y, size: 8, font: fontRegular, color: COLOR_GREY });
  y -= 12;
  page.drawText(COMPANY.addressLine1, { x: 40, y, size: 8, font: fontRegular, color: COLOR_GREY });
  y -= 11;
  page.drawText(COMPANY.addressLine2, { x: 40, y, size: 8, font: fontRegular, color: COLOR_GREY });
  y -= 15;
  page.drawText(`Tel: ${COMPANY.phone}`, { x: 40, y, size: 8, font: fontRegular, color: COLOR_GREY });
  y -= 12;
  page.drawText(`Email: ${COMPANY.email}`, { x: 40, y, size: 8, font: fontRegular, color: COLOR_GREY });

  // ── INVOICE META (right) ─────────────────────────────────────────────────
  let yRight = height - headerHeight - 30;
  page.drawText(`Date Issued: ${formatDate()}`, {
    x: width - 220, y: yRight, size: 9, font: fontRegular, color: COLOR_BLACK,
  });
  yRight -= 14;
  page.drawText(`Job Ref: ${job.invoice_no}`, {
    x: width - 220, y: yRight, size: 9, font: fontRegular, color: COLOR_BLACK,
  });
  yRight -= 14;
  page.drawText(`Milestone: ${MILESTONE_LABELS[milestone] || milestone}`, {
    x: width - 220, y: yRight, size: 9, font: fontBold, color: COLOR_BLUE, maxWidth: 200,
  });

  y -= 50;

  // ── BILL TO SECTION ───────────────────────────────────────────────────────
  page.drawRectangle({
    x: 40, y: y - 5, width: width - 80, height: 1, color: COLOR_BLUE,
  });
  y -= 20;

  page.drawText("BILL TO", { x: 40, y, size: 9, font: fontBold, color: COLOR_BLUE });
  y -= 16;
  page.drawText(customer?.full_name || "N/A", { x: 40, y, size: 11, font: fontBold, color: COLOR_BLACK });
  y -= 14;
  page.drawText(`Phone: ${customer?.phone || "N/A"}`, { x: 40, y, size: 9, font: fontRegular, color: COLOR_GREY });
  y -= 12;
  if (customer?.email) {
    page.drawText(`Email: ${customer.email}`, { x: 40, y, size: 9, font: fontRegular, color: COLOR_GREY });
    y -= 12;
  }
  y -= 8;

  page.drawText("PROPERTY", { x: 40, y, size: 9, font: fontBold, color: COLOR_BLUE });
  y -= 16;
  page.drawText(property?.address || "N/A", { x: 40, y, size: 10, font: fontRegular, color: COLOR_BLACK, maxWidth: 400 });
  y -= 14;
  page.drawText(
    `${property?.city || ""}, ${property?.state || ""} | Type: ${property?.property_type || "N/A"}`,
    { x: 40, y, size: 9, font: fontRegular, color: COLOR_GREY }
  );

  y -= 40;

  // ── INVOICE TABLE HEADER ─────────────────────────────────────────────────
  page.drawRectangle({
    x: 40, y: y - 8, width: width - 80, height: 26, color: COLOR_NAVY,
  });
  page.drawText("DESCRIPTION", { x: 50, y: y - 2, size: 9, font: fontBold, color: COLOR_WHITE });
  page.drawText("AMOUNT", { x: width - 130, y: y - 2, size: 9, font: fontBold, color: COLOR_WHITE });

  y -= 34;

  // ── INVOICE LINE ITEM ────────────────────────────────────────────────────
  page.drawText(`House Inspection Service - ${MILESTONE_LABELS[milestone] || milestone}`, {
    x: 50, y, size: 10, font: fontRegular, color: COLOR_BLACK, maxWidth: 350,
  });
  page.drawText(formatCurrency(amount), {
    x: width - 130, y, size: 10, font: fontBold, color: COLOR_BLACK,
  });

  y -= 20;
  page.drawRectangle({ x: 40, y, width: width - 80, height: 0.5, color: COLOR_GREY });

  y -= 30;

  // ── TOTAL DUE ─────────────────────────────────────────────────────────────
  page.drawRectangle({
    x: width - 220, y: y - 10, width: 180, height: 32, color: COLOR_LIGHT_BLUE,
  });
  page.drawText("TOTAL DUE", { x: width - 210, y: y, size: 10, font: fontBold, color: COLOR_NAVY });
  page.drawText(formatCurrency(amount), {
    x: width - 210, y: y - 14, size: 14, font: fontBold, color: COLOR_NAVY,
  });

  y -= 70;

  // ── PAYMENT TERMS NOTE ───────────────────────────────────────────────────
  page.drawText("PAYMENT TERMS", { x: 40, y, size: 9, font: fontBold, color: COLOR_BLUE });
  y -= 14;
  page.drawText(
    "Payment is required before work proceeds to the next stage.",
    { x: 40, y, size: 9, font: fontRegular, color: COLOR_GREY }
  );
  y -= 12;
  page.drawText(
    "Full schedule: 50% Deposit / 30% Completion / 20% Final (upon report submission).",
    { x: 40, y, size: 9, font: fontRegular, color: COLOR_GREY }
  );

  y -= 40;

  // ── BANK DETAILS BOX ─────────────────────────────────────────────────────
  page.drawRectangle({
    x: 40, y: y - 70, width: width - 80, height: 80, color: COLOR_LIGHT_BLUE,
  });
  page.drawText("PAYMENT DETAILS", { x: 55, y: y - 18, size: 10, font: fontBold, color: COLOR_NAVY });
  page.drawText(`Bank: ${COMPANY.bankName}`, { x: 55, y: y - 36, size: 9, font: fontRegular, color: COLOR_BLACK });
  page.drawText(`Account Name: ${COMPANY.bankAccountName}`, { x: 55, y: y - 50, size: 9, font: fontRegular, color: COLOR_BLACK });
  page.drawText(`Account Number: ${COMPANY.bankAccountNo}`, { x: 55, y: y - 64, size: 9, font: fontRegular, color: COLOR_BLACK });

  // ── FOOTER ────────────────────────────────────────────────────────────────
  page.drawText("Thank you for choosing Jabiru Ventures.", {
    x: 40, y: 50, size: 10, font: fontBold, color: COLOR_NAVY,
  });
  page.drawText(COMPANY.website, {
    x: 40, y: 36, size: 8, font: fontRegular, color: COLOR_GREY,
  });

  return await pdfDoc.save();
}

/**
 * Upload PDF to Supabase Storage and return a public URL.
 * Assumes a public bucket named "invoices" exists.
 */
async function uploadPdfToStorage(
  pdfBytes: Uint8Array,
  fileName: string
): Promise<string> {
  const res = await fetch(
    `${SB_URL}/storage/v1/object/invoices/${fileName}`,
    {
      method: "POST",
      headers: {
        apikey: SB_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SB_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/pdf",
        // Re-sending the same milestone should replace the old PDF rather
        // than 409 and silently leave the owner without a share link.
        "x-upsert": "true",
      },
      body: pdfBytes,
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to upload PDF to storage: ${err}`);
  }

  // The bucket is PRIVATE (invoices contain the client's name, address,
  // amounts and our bank details, and filenames are guessable). Hand back a
  // time-limited signed link instead of a public URL.
  const signRes = await fetch(
    `${SB_URL}/storage/v1/object/sign/invoices/${fileName}`,
    {
      method: "POST",
      headers: {
        apikey: SB_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SB_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expiresIn: SIGNED_URL_TTL_SECONDS }),
    }
  );

  if (!signRes.ok) {
    const err = await signRes.text();
    throw new Error(`Failed to sign PDF URL: ${err}`);
  }

  const signed = await signRes.json();
  return `${SB_URL}/storage/v1${signed.signedURL || signed.signedUrl}`;
}

/**
 * Send the invoice PDF to client via Email (Gmail SMTP) using a simple
 * raw SMTP implementation suited for Deno edge functions.
 * Uses Gmail's SMTP relay with an App Password.
 */
async function sendInvoiceEmail(
  toEmail: string,
  clientName: string,
  pdfBytes: Uint8Array,
  fileName: string,
  milestoneLabel: string,
  invoiceRef: string,
  amount: number
): Promise<void> {
  // Using a lightweight SMTP client compatible with Deno edge functions
  const { SMTPClient } = await import("https://deno.land/x/denomailer@1.6.0/mod.ts");

  const client = new SMTPClient({
    connection: {
      hostname: "smtp.gmail.com",
      port: 465,
      tls: true,
      auth: {
        username: GMAIL_SENDER_EMAIL,
        password: GMAIL_APP_PASSWORD,
      },
    },
  });

  const base64Pdf = btoa(String.fromCharCode(...pdfBytes));

  await client.send({
    from: GMAIL_SENDER_EMAIL,
    to: toEmail,
    subject: `Jabiru Ventures Invoice ${invoiceRef} - ${milestoneLabel}`,
    content: `Dear ${clientName},\n\nPlease find attached your invoice for ${milestoneLabel}.\n\nAmount Due: RM ${amount.toFixed(2)}\nReference: ${invoiceRef}\n\nKindly make payment to the bank details listed on the invoice. Work will proceed once payment is confirmed.\n\nThank you for choosing Jabiru Ventures.\n\nBest regards,\nJabiru Ventures`,
    attachments: [
      {
        filename: fileName,
        content: base64Pdf,
        encoding: "base64",
      },
    ],
  });

  await client.close();
}

/**
 * Require a signed-in CRM user. The anon/publishable key is public (it ships
 * in the page source), so it must NOT be enough to invoke this function —
 * otherwise anyone could send invoices to real customers. We verify the
 * caller's token against Supabase Auth and require a real user.
 */
async function requireUser(req: Request): Promise<boolean> {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token || token === Deno.env.get("SB_ANON_KEY")) return false;
  try {
    const res = await fetch(`${SB_URL}/auth/v1/user`, {
      headers: { apikey: SB_SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return false;
    const user = await res.json();
    return Boolean(user?.id);
  } catch (_e) {
    return false;
  }
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  if (!(await requireUser(req))) {
    console.warn("[Jabiru] \u274C Rejected unauthenticated call");
    return new Response(
      JSON.stringify({ error: "Unauthorized - please sign in" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }


  // ── Parse request body ───────────────────────────────────────────────────
  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON body" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const { job_id, milestone, amount } = body;

  if (!job_id || !milestone || amount === undefined) {
    return new Response(
      JSON.stringify({ error: "job_id, milestone, and amount are required" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  if (!["deposit", "completion", "final"].includes(milestone)) {
    return new Response(
      JSON.stringify({ error: "milestone must be 'deposit', 'completion', or 'final'" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  console.log(`[Jabiru] 🧾 Generating ${milestone} invoice for job: ${job_id}`);

  // ── Step 1: Fetch job details ────────────────────────────────────────────
  let job: any;
  try {
    job = await fetchJobDetails(job_id);
    if (!job) {
      return new Response(
        JSON.stringify({ error: "Job not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  } catch (err) {
    console.error("[Jabiru] ❌ Failed to fetch job:", err);
    return new Response(
      JSON.stringify({ error: "Failed to fetch job details" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const invoiceRef = `${job.invoice_no}-${getMilestoneSuffix(milestone)}`;
  const fileName = `${invoiceRef}.pdf`;

  // ── Step 2: Generate PDF ─────────────────────────────────────────────────
  let pdfBytes: Uint8Array;
  try {
    pdfBytes = await generateInvoicePdf(job, milestone, amount, invoiceRef);
    console.log("[Jabiru] ✅ PDF generated");
  } catch (err) {
    console.error("[Jabiru] ❌ PDF generation failed:", err);
    return new Response(
      JSON.stringify({ error: "Failed to generate invoice PDF" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // ── Step 3: Upload PDF to Supabase Storage (gives the owner a shareable link) ───
  let pdfUrl = "";
  try {
    pdfUrl = await uploadPdfToStorage(pdfBytes, fileName);
    console.log(`[Jabiru] ✅ PDF uploaded: ${pdfUrl}`);
  } catch (err) {
    console.error("[Jabiru] ❌ PDF upload failed:", err);
    // Continue — email can still be sent without the URL
  }

  // ── Step 4: Send via Email ───────────────────────────────────────────────
  const customer = job.customers;
  const milestoneLabel = MILESTONE_LABELS[milestone];

  if (customer?.email) {
    try {
      await sendInvoiceEmail(
        customer.email,
        customer.full_name || "Valued Customer",
        pdfBytes,
        fileName,
        milestoneLabel,
        invoiceRef,
        amount
      );
      console.log(`[Jabiru] ✅ Invoice emailed to ${customer.email}`);
    } catch (err) {
      console.error("[Jabiru] ❌ Email send failed:", err);
    }
  } else {
    console.log("[Jabiru] ℹ️ No client email on file — skipped email send");
  }

  // ── Step 5: Log invoice in Supabase ──────────────────────────────────────
  try {
    await logInvoice(job_id, milestone, amount, invoiceRef);
    console.log("[Jabiru] ✅ Invoice logged");
  } catch (err) {
    console.error("[Jabiru] ⚠️ Failed to log invoice (non-fatal):", err);
  }

  // pdf_url is returned so the CRM can offer a manual "open WhatsApp to share"
  // action (prefilled wa.me link) — no automated WhatsApp send happens here.
  return new Response(
    JSON.stringify({
      success: true,
      invoice_ref: invoiceRef,
      milestone: milestone,
      amount: amount,
      pdf_url: pdfUrl || null,
      message: "Invoice generated, uploaded, and emailed successfully",
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
