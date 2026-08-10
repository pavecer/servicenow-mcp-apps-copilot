import { describe, expect, it, vi } from "vitest";
import type { AxiosInstance } from "axios";
import { ServiceNowClient } from "../src/services/servicenowClient";
import { runWithRequestContext } from "../src/requestContext";

const REQUEST_ID = "a".repeat(32);
const APPROVAL_ID = "b".repeat(32);
const MANAGER_ID = "c".repeat(32);
const OTHER_USER_ID = "d".repeat(32);
const REQUESTOR_ID = "e".repeat(32);

function createClient(approval: Record<string, unknown>, callerSysId = MANAGER_ID) {
  const axiosMock = {
    get: vi.fn()
      .mockResolvedValueOnce({ data: { result: approval } })
      .mockResolvedValueOnce({
        data: { result: [{ sys_id: callerSysId, email: "manager@contoso.com" }] }
      }),
    patch: vi.fn().mockResolvedValue({ data: { result: { ...approval, state: "approved" } } })
  };
  const client = new ServiceNowClient();
  (client as unknown as { getClient: () => Promise<AxiosInstance> }).getClient = vi.fn()
    .mockResolvedValue(axiosMock as unknown as AxiosInstance);
  return { client, axiosMock };
}

function pendingApproval(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sys_id: APPROVAL_ID,
    sysapproval: { value: REQUEST_ID, display_value: "REQ001" },
    approver: { value: MANAGER_ID, display_value: "Manager One" },
    state: { value: "requested", display_value: "Requested" },
    ...overrides
  };
}

describe("ServiceNowClient approval authorization", () => {
  it("rejects order detail for a caller who is neither requestor nor approver", async () => {
    const axiosMock = {
      get: vi.fn()
        .mockResolvedValueOnce({
          data: { result: { sys_id: REQUEST_ID, requested_for: { value: REQUESTOR_ID } } }
        })
        .mockResolvedValueOnce({
          data: { result: [{ sys_id: OTHER_USER_ID, email: "other@contoso.com" }] }
        })
        .mockResolvedValueOnce({ data: { result: [] } }),
      patch: vi.fn()
    };
    const client = new ServiceNowClient();
    (client as unknown as { getClient: () => Promise<AxiosInstance> }).getClient = vi.fn()
      .mockResolvedValue(axiosMock as unknown as AxiosInstance);

    await expect(runWithRequestContext(
      { callerUpn: "other@contoso.com" },
      () => client.getOrderDetail(REQUEST_ID, { includeApprovals: true })
    )).rejects.toThrow(/do not have access/i);

    expect(axiosMock.get).toHaveBeenCalledTimes(3);
  });

  it("allows an assigned approver to read order detail", async () => {
    const axiosMock = {
      get: vi.fn()
        .mockResolvedValueOnce({
          data: { result: { sys_id: REQUEST_ID, requested_for: { value: REQUESTOR_ID } } }
        })
        .mockResolvedValueOnce({
          data: { result: [{ sys_id: MANAGER_ID, email: "manager@contoso.com" }] }
        })
        .mockResolvedValueOnce({ data: { result: [{ sys_id: APPROVAL_ID }] } })
        .mockResolvedValueOnce({ data: { result: [] } })
        .mockResolvedValueOnce({ data: { result: [pendingApproval()] } }),
      patch: vi.fn()
    };
    const client = new ServiceNowClient();
    (client as unknown as { getClient: () => Promise<AxiosInstance> }).getClient = vi.fn()
      .mockResolvedValue(axiosMock as unknown as AxiosInstance);

    const detail = await runWithRequestContext(
      { callerUpn: "manager@contoso.com" },
      () => client.getOrderDetail(REQUEST_ID, { includeApprovals: true })
    );

    expect(detail.approvals[0].can_decide).toBe(true);
  });

  it("rejects updates to an order not owned by the caller", async () => {
    const axiosMock = {
      get: vi.fn()
        .mockResolvedValueOnce({
          data: { result: { sys_id: REQUEST_ID, requested_for: { value: REQUESTOR_ID } } }
        })
        .mockResolvedValueOnce({
          data: { result: [{ sys_id: OTHER_USER_ID, email: "other@contoso.com" }] }
        }),
      patch: vi.fn()
    };
    const client = new ServiceNowClient();
    (client as unknown as { getClient: () => Promise<AxiosInstance> }).getClient = vi.fn()
      .mockResolvedValue(axiosMock as unknown as AxiosInstance);

    await expect(runWithRequestContext(
      { callerUpn: "other@contoso.com" },
      () => client.updateOrder(REQUEST_ID, { comments: "Cancel this request" })
    )).rejects.toThrow(/do not have access/i);

    expect(axiosMock.patch).not.toHaveBeenCalled();
  });

  it("marks only the caller's pending approval as actionable in order detail", async () => {
    const axiosMock = {
      get: vi.fn()
        .mockResolvedValueOnce({
          data: {
            result: {
              sys_id: REQUEST_ID,
              number: "REQ001",
              requested_for: { value: MANAGER_ID, display_value: "Manager One" }
            }
          }
        })
        .mockResolvedValueOnce({
          data: { result: [{ sys_id: MANAGER_ID, email: "manager@contoso.com" }] }
        })
        .mockResolvedValueOnce({ data: { result: [] } })
        .mockResolvedValueOnce({
          data: {
            result: [
              pendingApproval(),
              pendingApproval({ sys_id: "1".repeat(32), approver: { value: "2".repeat(32), display_value: "Manager Two" } }),
              pendingApproval({ sys_id: "3".repeat(32), state: { value: "approved", display_value: "Approved" } })
            ]
          }
        }),
      patch: vi.fn()
    };
    const client = new ServiceNowClient();
    (client as unknown as { getClient: () => Promise<AxiosInstance> }).getClient = vi.fn()
      .mockResolvedValue(axiosMock as unknown as AxiosInstance);

    const detail = await runWithRequestContext(
      { callerUpn: "manager@contoso.com" },
      () => client.getOrderDetail(REQUEST_ID, { includeApprovals: true })
    );

    expect(detail.approvals.map(approval => approval.can_decide)).toEqual([true, false, false]);
  });

  it("allows the assigned caller to decide a pending approval", async () => {
    const { client, axiosMock } = createClient(pendingApproval());

    await runWithRequestContext(
      { callerUpn: "manager@contoso.com" },
      () => client.decideOrderApproval(APPROVAL_ID, "approved", {
        requestSysId: REQUEST_ID,
        comment: "Approved"
      })
    );

    expect(axiosMock.patch).toHaveBeenCalledWith(
      `/api/now/table/sysapproval_approver/${APPROVAL_ID}`,
      { state: "approved", comments: "Approved" }
    );
  });

  it("rejects a caller who is not the assigned approver", async () => {
    const { client, axiosMock } = createClient(pendingApproval(), OTHER_USER_ID);

    await expect(runWithRequestContext(
      { callerUpn: "manager@contoso.com" },
      () => client.decideOrderApproval(APPROVAL_ID, "approved", { requestSysId: REQUEST_ID })
    )).rejects.toThrow(/assigned approver/i);

    expect(axiosMock.patch).not.toHaveBeenCalled();
  });

  it("rejects an approval that is no longer pending before caller lookup or patch", async () => {
    const { client, axiosMock } = createClient(pendingApproval({
      state: { value: "approved", display_value: "Approved" }
    }));

    await expect(runWithRequestContext(
      { callerUpn: "manager@contoso.com" },
      () => client.decideOrderApproval(APPROVAL_ID, "rejected", { requestSysId: REQUEST_ID })
    )).rejects.toThrow(/no longer pending/i);

    expect(axiosMock.get).toHaveBeenCalledTimes(1);
    expect(axiosMock.patch).not.toHaveBeenCalled();
  });

  it("serializes concurrent decisions for the same approval", async () => {
    let releasePatch: (value: { data: { result: Record<string, unknown> } }) => void = () => {};
    const patchResult = new Promise<{ data: { result: Record<string, unknown> } }>(resolve => {
      releasePatch = resolve;
    });
    const axiosMock = {
      get: vi.fn()
        .mockResolvedValueOnce({ data: { result: pendingApproval() } })
        .mockResolvedValueOnce({
          data: { result: [{ sys_id: MANAGER_ID, email: "manager@contoso.com" }] }
        })
        .mockResolvedValueOnce({
          data: { result: pendingApproval({ state: { value: "approved", display_value: "Approved" } }) }
        }),
      patch: vi.fn().mockReturnValueOnce(patchResult)
    };
    const client = new ServiceNowClient();
    (client as unknown as { getClient: () => Promise<AxiosInstance> }).getClient = vi.fn()
      .mockResolvedValue(axiosMock as unknown as AxiosInstance);

    const first = runWithRequestContext(
      { callerUpn: "manager@contoso.com" },
      () => client.decideOrderApproval(APPROVAL_ID, "approved", { requestSysId: REQUEST_ID })
    );
    await vi.waitFor(() => expect(axiosMock.patch).toHaveBeenCalledTimes(1));
    const second = runWithRequestContext(
      { callerUpn: "manager@contoso.com" },
      () => client.decideOrderApproval(APPROVAL_ID, "rejected", { requestSysId: REQUEST_ID })
    );
    await Promise.resolve();
    expect(axiosMock.get).toHaveBeenCalledTimes(2);

    releasePatch({ data: { result: pendingApproval({ state: "approved" }) } });
    await expect(first).resolves.toMatchObject({ state: "approved" });
    await expect(second).rejects.toThrow(/no longer pending/i);
    expect(axiosMock.patch).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed sys_ids before making a ServiceNow request", async () => {
    const client = new ServiceNowClient();
    const getClient = vi.fn();
    (client as unknown as { getClient: () => Promise<AxiosInstance> }).getClient = getClient;

    await expect(client.getOrderDetail(`${REQUEST_ID}#^ORsys_idISNOTEMPTY`)).rejects.toThrow(/32-character/i);
    await expect(client.updateOrder("not-a-sys-id", { comments: "No" })).rejects.toThrow(/32-character/i);
    await expect(client.decideOrderApproval("not-a-sys-id", "approved")).rejects.toThrow(/32-character/i);
    expect(getClient).not.toHaveBeenCalled();
  });
});