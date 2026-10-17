import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";

const unprocessable = (c: string) => new UnprocessableEntityException(c);
const CODES: Record<string, (code: string) => HttpException> = {
  placement_not_found: () => new NotFoundException(),
  invoice_not_found: () => new NotFoundException(),
  payment_not_found: () => new NotFoundException(),
  not_permitted: () => new ForbiddenException("Not permitted"),
  stale: () => new HttpException("stale", HttpStatus.PRECONDITION_FAILED),
  invoice_no_exists: (c) => new ConflictException(c),
  placement_not_joined: unprocessable,
  invalid_invoice: unprocessable,
  invalid_invoice_date: unprocessable,
  invoice_void: unprocessable,
  invoice_has_payments: unprocessable,
  amount_below_received: unprocessable,
  invalid_payment_date: unprocessable,
  invalid_amount: unprocessable,
  overpayment: unprocessable,
  invoice_received: unprocessable,
  payment_void: unprocessable,
};

/**
 * Maps errors raised by the payment definer functions (migration 0100) to
 * problem details with a stable code in `detail`. A duplicate invoice number
 * never names the other invoice.
 */
export function mapPaymentError(err: unknown): never {
  const e = err as { message?: string; code?: string; constraint?: string };
  const make = e.message !== undefined ? CODES[e.message] : undefined;
  if (make && e.code !== undefined) throw make(e.message!);
  if (e.code === "23505" && e.constraint === "invoice_number_live") throw new ConflictException("invoice_no_exists");
  throw err;
}
