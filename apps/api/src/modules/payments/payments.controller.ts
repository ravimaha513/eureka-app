import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { CurrentUser, RequirePermission, type AuthedUser } from "../../platform/auth.guard.js";
import {
  BillablePlacementQuery, CreateInvoice, Empty, InvoiceListQuery, InvoiceSummaryQuery, RecordPayment, UpdateInvoice, parseIfMatch,
} from "./payments.schemas.js";
import { PaymentsService } from "./payments.service.js";

export { PaymentsService };

/**
 * docs/payments-api.md: the Payments / incentive dashboard. Reads need
 * invoice:read (Accounts and CEO org, Sales by scope); writes invoice:update
 * (Accounts).
 */
@Controller("api/v1/invoices")
export class PaymentsController {
  constructor(private readonly svc: PaymentsService) {}

  @Get()
  @RequirePermission("invoice:read")
  list(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    return this.svc.list(user, InvoiceListQuery.parse(q));
  }

  @Get("summary")
  @RequirePermission("invoice:read")
  summary(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    return this.svc.summary(user, InvoiceSummaryQuery.parse(q));
  }

  /** Joined placements that can carry invoices (picker for a new invoice; placements not invoiced yet). */
  @Get("placements")
  @RequirePermission("invoice:read")
  placements(@CurrentUser() user: AuthedUser, @Query() q: unknown) {
    return this.svc.billablePlacements(user, BillablePlacementQuery.parse(q));
  }

  @Get(":id")
  @RequirePermission("invoice:read")
  get(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.svc.get(user, id);
  }

  /** Idempotency-Key is required; a repeat with the same body returns the first response. */
  @Post()
  @RequirePermission("invoice:update")
  create(@CurrentUser() user: AuthedUser, @Body() body: unknown, @Headers("idempotency-key") key: string | undefined) {
    return this.svc.create(user, CreateInvoice.parse(body), key);
  }

  /** If-Match carries the rowVersion the client saw (428 without it, 412 when stale). */
  @Patch(":id")
  @RequirePermission("invoice:update")
  update(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown,
    @Headers("if-match") ifMatch: string | undefined) {
    return this.svc.update(user, id, parseIfMatch(ifMatch), UpdateInvoice.parse(body));
  }

  @Post(":id/void")
  @HttpCode(200)
  @RequirePermission("invoice:update")
  void(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown,
    @Headers("if-match") ifMatch: string | undefined) {
    Empty.parse(body ?? {});
    return this.svc.void(user, id, parseIfMatch(ifMatch));
  }

  /** Idempotency-Key is required (design B3: payment creation). */
  @Post(":id/payments")
  @RequirePermission("invoice:update")
  recordPayment(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown,
    @Headers("idempotency-key") key: string | undefined) {
    return this.svc.recordPayment(user, id, RecordPayment.parse(body), key);
  }

  @Post(":id/payments/:paymentId/void")
  @HttpCode(200)
  @RequirePermission("invoice:update")
  voidPayment(@CurrentUser() user: AuthedUser, @Param("id", ParseUUIDPipe) id: string,
    @Param("paymentId", ParseUUIDPipe) paymentId: string, @Body() body: unknown) {
    Empty.parse(body ?? {});
    return this.svc.voidPayment(user, id, paymentId);
  }
}
