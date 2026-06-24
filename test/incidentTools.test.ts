import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ServiceNowClient } from "../src/services/servicenowClient";
import { parseCommentJournal } from "../src/services/servicenowClient";
import { registerGetIncidentFormTool } from "../src/tools/getIncidentForm";
import { registerReportIncidentTool } from "../src/tools/reportIncident";
import { registerListUserIncidentsTool } from "../src/tools/listUserIncidents";
import { registerGetIncidentDetailTool } from "../src/tools/getIncidentDetail";
import { registerAddIncidentCommentTool } from "../src/tools/addIncidentComment";
import { registerAddIncidentAttachmentTool } from "../src/tools/addIncidentAttachment";
import { getMinimalToolDefinitions } from "../src/tools/index";

interface RegisteredTool {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

function createFakeServer() {
  const tools: RegisteredTool[] = [];
  return {
    tools,
    server: {
      tool: (name: string, _d: string, _s: Record<string, unknown>, handler: RegisteredTool["handler"]) => {
        tools.push({ name, handler });
      }
    }
  };
}

const DETAIL = {
  incident: {
    sys_id: { value: "inc-sys-1", display_value: "inc-sys-1" },
    number: { value: "INC0012345", display_value: "INC0012345" },
    short_description: { value: "Laptop won't boot", display_value: "Laptop won't boot" },
    state: { value: "1", display_value: "New" }
  },
  comments: [
    { value: "Tried restarting, no luck.", createdOn: "2026-06-24 09:00:00", createdBy: "alex", field: "comments" as const }
  ],
  attachments: [
    { sysId: "att-1", fileName: "screenshot.png", contentType: "image/png", sizeBytes: "2048", downloadLink: "https://example.service-now.com/sys_attachment.do?sys_id=att-1" }
  ]
};

describe("incident tool manifest", () => {
  it("manifest includes the six incident tools with the right widget bindings", () => {
    const byName = Object.fromEntries(getMinimalToolDefinitions().map(t => [t.name, t]));
    for (const name of ["get_incident_form", "report_incident", "list_user_incidents", "get_incident_detail", "add_incident_comment", "add_incident_attachment"]) {
      expect(byName[name]).toBeDefined();
    }
    const meta = byName.get_incident_form._meta as Record<string, unknown> | undefined;
    expect((meta as Record<string, unknown>)["ui/resourceUri"]).toBe("ui://servicenow-mcp/incident-form.html");
    const listMeta = byName.list_user_incidents._meta as { ui?: { resourceUri?: string } };
    expect(listMeta?.ui?.resourceUri).toBe("ui://servicenow-mcp/my-incidents.html");
    const reportMeta = byName.report_incident._meta as { ui?: { resourceUri?: string } };
    expect(reportMeta?.ui?.resourceUri).toBe("ui://servicenow-mcp/incident-detail.html");
    const attachMeta = byName.add_incident_attachment._meta as { ui?: { resourceUri?: string } };
    expect(attachMeta?.ui?.resourceUri).toBe("ui://servicenow-mcp/incident-detail.html");
  });
});

describe("parseCommentJournal", () => {
  it("parses a multi-entry comments journal display value oldest-first", () => {
    // ServiceNow renders the record's comments journal newest-first; the parser
    // normalizes to oldest-first for a natural conversation order.
    const display =
      "2026-06-24 06:00:00 - Jane Doe (Comments)\nAny update on this?\n\n" +
      "2026-06-24 05:10:35 - MCP Integration (Comments)\nTried restarting, no luck.\nStill broken.\n\n";
    const out = parseCommentJournal({ display_value: display, value: "" });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ createdBy: "MCP Integration", createdOn: "2026-06-24 05:10:35", field: "comments" });
    expect(out[0].value).toBe("Tried restarting, no luck.\nStill broken.");
    expect(out[1]).toMatchObject({ createdBy: "Jane Doe", value: "Any update on this?" });
  });

  it("returns [] for empty/missing journals", () => {
    expect(parseCommentJournal("")).toEqual([]);
    expect(parseCommentJournal({ display_value: "" })).toEqual([]);
    expect(parseCommentJournal(undefined)).toEqual([]);
  });

  it("accepts a plain string display value", () => {
    const out = parseCommentJournal("2026-06-24 05:10:35 - Alex (Comments)\nHello");
    expect(out).toHaveLength(1);
    expect(out[0].value).toBe("Hello");
  });
});

describe("get_incident_form", () => {
  it("returns a static field schema with a required shortDescription", async () => {
    const fake = createFakeServer();
    registerGetIncidentFormTool(fake.server as never);
    const result = (await fake.tools[0].handler({})) as { structuredContent?: { fields?: Array<Record<string, unknown>> } };
    const fields = result.structuredContent?.fields ?? [];
    const sd = fields.find(f => f.name === "shortDescription");
    expect(sd).toMatchObject({ name: "shortDescription", required: true });
    // Choice fields are present for triage.
    expect(fields.find(f => f.name === "urgency")?.choices).toBeDefined();
    expect(fields.find(f => f.name === "category")?.choices).toBeDefined();
  });
});

describe("incident tool handlers", () => {
  let fakeClient: ServiceNowClient;
  let createIncident: ReturnType<typeof vi.fn>;
  let listUserIncidents: ReturnType<typeof vi.fn>;
  let getIncidentDetail: ReturnType<typeof vi.fn>;
  let addIncidentComment: ReturnType<typeof vi.fn>;
  let addIncidentAttachment: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    createIncident = vi.fn().mockResolvedValue({ number: "INC0012345", sys_id: "inc-sys-1" });
    listUserIncidents = vi.fn().mockResolvedValue([
      { sys_id: "inc-sys-1", number: "INC0012345", short_description: "Laptop won't boot", state: "New", category: "hardware", sys_updated_on: "2026-06-24 09:00:00" }
    ]);
    getIncidentDetail = vi.fn().mockResolvedValue(DETAIL);
    addIncidentComment = vi.fn().mockResolvedValue(undefined);
    addIncidentAttachment = vi.fn().mockResolvedValue({ sysId: "att-2", fileName: "shot.png", contentType: "image/png", sizeBytes: "10", downloadLink: "x" });
    fakeClient = {
      createIncident,
      listUserIncidents,
      getIncidentDetail,
      addIncidentComment,
      addIncidentAttachment
    } as unknown as ServiceNowClient;
  });

  it("report_incident creates the incident and returns submitted incident-detail content", async () => {
    const fake = createFakeServer();
    registerReportIncidentTool(fake.server as never, fakeClient);
    const result = (await fake.tools[0].handler({ shortDescription: "Laptop won't boot", urgency: "2" })) as {
      structuredContent?: { submitted?: boolean; number?: string; incident?: unknown; comments?: unknown[] };
    };
    expect(createIncident).toHaveBeenCalledWith({
      shortDescription: "Laptop won't boot",
      description: undefined,
      category: undefined,
      urgency: "2",
      impact: undefined
    });
    expect(result.structuredContent?.submitted).toBe(true);
    expect(result.structuredContent?.number).toBe("INC0012345");
    expect(result.structuredContent?.incident).toBeDefined();
  });

  it("list_user_incidents projects rows and a count", async () => {
    const fake = createFakeServer();
    registerListUserIncidentsTool(fake.server as never, fakeClient);
    const result = (await fake.tools[0].handler({})) as {
      structuredContent?: { count?: number; incidents?: Array<Record<string, unknown>> };
    };
    expect(result.structuredContent?.count).toBe(1);
    const inc = result.structuredContent?.incidents?.[0];
    expect(inc).toMatchObject({ number: "INC0012345", state: "New", updated_on: "2026-06-24 09:00:00" });
  });

  it("list_user_incidents returns an empty structuredContent when there are none", async () => {
    listUserIncidents.mockResolvedValueOnce([]);
    const fake = createFakeServer();
    registerListUserIncidentsTool(fake.server as never, fakeClient);
    const result = (await fake.tools[0].handler({})) as { structuredContent?: { count?: number; incidents?: unknown[] } };
    expect(result.structuredContent?.count).toBe(0);
    expect(result.structuredContent?.incidents).toEqual([]);
  });

  it("get_incident_detail returns incident + comments + attachments + link", async () => {
    const fake = createFakeServer();
    registerGetIncidentDetailTool(fake.server as never, fakeClient);
    const result = (await fake.tools[0].handler({ incidentSysId: "inc-sys-1" })) as {
      structuredContent?: { incident?: unknown; comments?: unknown[]; attachments?: unknown[]; link?: string };
    };
    expect(getIncidentDetail).toHaveBeenCalledWith("inc-sys-1");
    expect(result.structuredContent?.incident).toBeDefined();
    expect(result.structuredContent?.comments).toHaveLength(1);
    expect(result.structuredContent?.attachments).toHaveLength(1);
    expect(result.structuredContent?.link).toContain("/incident.do?sys_id=inc-sys-1");
  });

  it("add_incident_comment posts the comment then re-renders the detail", async () => {
    const fake = createFakeServer();
    registerAddIncidentCommentTool(fake.server as never, fakeClient);
    const result = (await fake.tools[0].handler({ incidentSysId: "inc-sys-1", comment: "Any update?" })) as {
      structuredContent?: { incident?: unknown; comments?: unknown[] };
    };
    expect(addIncidentComment).toHaveBeenCalledWith("inc-sys-1", "Any update?");
    expect(getIncidentDetail).toHaveBeenCalledWith("inc-sys-1");
    expect(result.structuredContent?.comments).toHaveLength(1);
  });

  it("add_incident_attachment decodes base64, uploads, then re-renders detail", async () => {
    const fake = createFakeServer();
    registerAddIncidentAttachmentTool(fake.server as never, fakeClient);
    const dataBase64 = Buffer.from("hello").toString("base64");
    const result = (await fake.tools[0].handler({
      incidentSysId: "inc-sys-1",
      fileName: "shot.png",
      contentType: "image/png",
      dataBase64
    })) as { structuredContent?: { attachments?: unknown[] } };
    expect(addIncidentAttachment).toHaveBeenCalledTimes(1);
    const call = addIncidentAttachment.mock.calls[0];
    expect(call[0]).toBe("inc-sys-1");
    expect(call[1].fileName).toBe("shot.png");
    expect(Buffer.isBuffer(call[1].data)).toBe(true);
    expect(call[1].data.toString()).toBe("hello");
    expect(getIncidentDetail).toHaveBeenCalledWith("inc-sys-1");
    expect(result.structuredContent?.attachments).toHaveLength(1);
  });

  it("add_incident_attachment rejects an oversized file", async () => {
    const fake = createFakeServer();
    registerAddIncidentAttachmentTool(fake.server as never, fakeClient);
    // 6 MB of base64 -> over the 5 MB cap.
    const big = Buffer.alloc(6 * 1024 * 1024, 1).toString("base64");
    const result = (await fake.tools[0].handler({
      incidentSysId: "inc-sys-1",
      fileName: "big.bin",
      contentType: "application/octet-stream",
      dataBase64: big
    })) as { content: Array<{ text: string }> };
    expect(addIncidentAttachment).not.toHaveBeenCalled();
    const payload = JSON.parse(result.content[0].text) as Record<string, unknown>;
    expect(payload.success).toBe(false);
    expect(String(payload.error)).toMatch(/too large/i);
  });
});
