import { AdminTx } from "./admin-tx.js";
import { CoachService } from "./coach.service.js";
import { OrgChartService } from "./org-chart.service.js";
import { OrgUnitsService } from "./org-units.service.js";
import { RoleRequestsService } from "./role-requests.service.js";
import { RolesService } from "./roles.service.js";
import { TeamsService } from "./teams.service.js";
import { UserImportService } from "./user-import.service.js";
import { AdminUsersService } from "./users.service.js";

/**
 * The admin and team services (audit C-04: the former AdminService split by
 * sub-domain). AppModule registers them as one list so a new admin service
 * does not touch the hot module file.
 */
export const ADMIN_PROVIDERS = [
  AdminTx, AdminUsersService, UserImportService, RolesService, RoleRequestsService, OrgChartService, OrgUnitsService, TeamsService, CoachService,
];
