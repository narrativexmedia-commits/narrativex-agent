import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL"),
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
);

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const FROM_EMAIL = "NarrativeX Alerts <alerts@narrativexmedia.com>"; // change to your verified Resend domain

Deno.serve(async () => {
  try {
    // Work hours check: 9:30–18:30 IST = 4:00–13:00 UTC
    const now = new Date();
    const utcHour = now.getUTCHours();
    const utcMin = now.getUTCMinutes();
    const totalUtcMin = utcHour * 60 + utcMin;
    const workStart = 4 * 60;       // 9:30 IST = 4:00 UTC
    const workEnd = 13 * 60;        // 18:30 IST = 13:00 UTC
    const dayOfWeek = now.getUTCDay(); // 0=Sun

    if (dayOfWeek === 0 || totalUtcMin < workStart || totalUtcMin > workEnd) {
      return new Response(JSON.stringify({ ok: true, reason: "outside work hours" }), { status: 200 });
    }

    // Get all active employees
    const { data: employees, error: empErr } = await supabase
      .from("profiles")
      .select("id, full_name, email")
      .eq("role", "employee")
      .eq("is_active", true);

    if (empErr) throw empErr;
    if (!employees?.length) return new Response(JSON.stringify({ ok: true, reason: "no employees" }), { status: 200 });

    // Get latest heartbeat per employee
    const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();

    const { data: recentHB } = await supabase
      .from("agent_heartbeats")
      .select("employee_id")
      .gte("created_at", fifteenMinAgo);

    const onlineIds = new Set((recentHB || []).map((h) => h.employee_id));
    const crashed = employees.filter((e) => !onlineIds.has(e.id));

    if (!crashed.length) {
      return new Response(JSON.stringify({ ok: true, crashed: 0 }), { status: 200 });
    }

    // Filter: skip employees already alerted in last 1 hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: recentAlerts } = await supabase
      .from("agent_alert_log")
      .select("employee_id")
      .gte("alerted_at", oneHourAgo);

    const alreadyAlerted = new Set((recentAlerts || []).map((a) => a.employee_id));
    const toAlert = crashed.filter((e) => !alreadyAlerted.has(e.id));

    if (!toAlert.length) {
      return new Response(JSON.stringify({ ok: true, reason: "already alerted recently", crashed: crashed.length }), { status: 200 });
    }

    // Get admin emails
    const { data: admins } = await supabase
      .from("profiles")
      .select("email, full_name")
      .eq("role", "admin");

    const adminEmails = (admins || []).map((a) => a.email).filter(Boolean);
    if (!adminEmails.length) throw new Error("No admin emails found");

    // Build email
    const crashList = toAlert
      .map((e) => `<li style="margin:4px 0;">${e.full_name}</li>`)
      .join("");

    const istTime = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;">
        <div style="background:#FEF2F2;border:1px solid #FECACA;border-radius:8px;padding:16px 20px;margin-bottom:20px;">
          <h2 style="margin:0 0 4px;color:#DC2626;font-size:16px;">⚠️ Agent Offline Detected</h2>
          <p style="margin:0;color:#7F1D1D;font-size:13px;">${istTime} IST</p>
        </div>
        <p style="color:#374151;font-size:14px;margin-bottom:8px;">
          The following employee(s) have not sent a heartbeat in the last <strong>15 minutes</strong>:
        </p>
        <ul style="color:#111827;font-size:14px;padding-left:20px;">
          ${crashList}
        </ul>
        <p style="color:#6B7280;font-size:13px;margin-top:16px;">
          The NarrativeX Agent on their PC may have crashed or been closed.
          Please check with the employee.
        </p>
        <hr style="border:none;border-top:1px solid #E5E7EB;margin:20px 0;" />
        <p style="color:#9CA3AF;font-size:12px;margin:0;">NarrativeX Tracker — automated alert</p>
      </div>
    `;

    // Send via Resend
    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: adminEmails,
        subject: `⚠️ NarrativeX Agent Offline: ${toAlert.map((e) => e.full_name).join(", ")}`,
        html,
      }),
    });

    if (!resendRes.ok) {
      const err = await resendRes.text();
      throw new Error(`Resend error: ${err}`);
    }

    // Log alerts to prevent spam
    await supabase.from("agent_alert_log").insert(
      toAlert.map((e) => ({ employee_id: e.id }))
    );

    return new Response(
      JSON.stringify({ ok: true, alerted: toAlert.length, employees: toAlert.map((e) => e.full_name) }),
      { status: 200 }
    );
  } catch (err) {
    console.error("check-agent-health error:", err);
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 500 });
  }
});