import type { CheckItemRow, CheckRow } from '../../db/schema';

export interface CheckItemResponse {
  name: string;
  quantity: number;
  unitPrice: number;
}

export interface CheckResponse {
  id: string;
  restaurantId: string;
  status: CheckRow['status'];
  total: number;
  items: CheckItemResponse[];
  createdAt: string;
  paidAt: string | null;
  cancelledAt: string | null;
}

export function toCheckResponse(check: CheckRow, items: CheckItemRow[]): CheckResponse {
  return {
    id: check.id,
    restaurantId: check.restaurantId,
    status: check.status,
    total: Number(check.total),
    items: items.map((i) => ({
      name: i.name,
      quantity: i.quantity,
      unitPrice: Number(i.unitPrice),
    })),
    createdAt: check.createdAt.toISOString(),
    paidAt: check.paidAt?.toISOString() ?? null,
    cancelledAt: check.cancelledAt?.toISOString() ?? null,
  };
}
