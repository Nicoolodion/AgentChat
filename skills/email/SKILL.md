---
skill: email
description: "Send email to the user with optional file attachments. Auto-loaded when the user asks to receive something by email ('schick es mir per Email', 'send it to me by email'). Pairs with document skills so the agent can produce a file and email it in one task."
routes:
  - name: Produce-and-email
    condition: "User wants a deliverable emailed to them"
    reference: "#produce-and-email"
dependencies:
  - name: "send_email tool"
    check: "documented in the system prompt"
quality_standards:
  - "Use send_email with attachments from the workspace output/ dir"
  - "Default the recipient by omitting 'to' (sends to the user's verified email)"
  - "On email-originated tasks, do NOT call send_email (the system auto-sends a completion email)"
---

# Email Skill

## Routing

**Produce-and-email** — the default and only route. When the user asks to
receive something by email (e.g. "Bereite mir die ganze Information als PDF
vor und schick es mir per Email"), produce the deliverable using the
appropriate skill (pdf, docx, xlsx, pptx) into the `output/` directory, then
call `send_email` with the produced file(s) attached.

## send_email Tool

```
send_email(
  to?: string,           # omit → user's verified email (common case)
  subject?: string,      # omit → "From your agent"
  body?: string,          # plain text body; omit → "(see attached result)"
  html?: string,          # optional HTML body
  attachments?: string[] # workspace-relative paths, e.g. ["output/report.pdf"]
)
```

- **Default recipient:** omit `to` to send to the user's verified email. Only
  set `to` when the user explicitly names a different address.
- **Attachments:** pass workspace paths (NOT base64). The tool reads each file
  host-side and copies it into the outbound MIME inline.
- **No verified email:** if the user hasn't verified an email, the tool returns
  an error. Tell the user to verify their email in the app Settings, then they
  can re-run or you proceed and the system emails them the result when they do.

## Source-aware guidance

The system injects the task source into the system prompt. The key rule:

- **If the task was started FROM AN EMAIL REPLY** (`source === "email"`): a
  completion email with the final answer + artifacts is sent **automatically
  by the system** at the end of the run. Do NOT call `send_email` mid-run — it
  would double-mail the user. Just produce the answer (and any artifacts, which
  the completion email attaches).
- **If the task was started from the mobile app or desktop** (`source ===
  "mobile" | "desktop"`): no completion email is auto-sent. Call `send_email`
  when the user asks to receive the result by email.

This keeps the two paths from double-mailing.

## Workflow Example

User: "Bereite mir die ganze Information als pdf vor und schick es mir per email"

1. Gather / research the information (web_search, web_fetch, file_read).
2. Write the HTML report to `output/info.html` (follow the pdf skill).
3. `pdf_from_html(output/info.html, output/info.pdf)`.
4. `send_email(attachments: ["output/info.pdf"])` — recipient defaults to the
   user's verified email, subject derived from the task.

If `source === "email"`, SKIP step 4 — the completion email auto-attaches the
PDF.

## Quality Standards

- Attach files from `output/` (final deliverables), never `temp/`.
- Use descriptive subject lines when the user's intent is specific.
- Confirm what you sent to the user in your final message (filename +recipient).
- One send_email call per task unless the user asks for separate emails to
  different recipients.
