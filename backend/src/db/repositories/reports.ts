import { createReportQueries } from '@smartdesk/analytics';
import { forbiddenError, validationError } from '../errors.js';

export type {
  AcceptanceReport,
  AccuracyReport,
  CategoryCount,
  ConfusionCell,
  DailyIntake,
  FirstResponseReport,
  ModelAcceptance,
  ModelAccuracy,
  ReportWindow,
  ResolutionReport,
  RoutingReport,
} from '@smartdesk/analytics';

export const reportQueries = createReportQueries({
  forbidden: forbiddenError,
  invalidWindow: validationError,
});
export const {
  reportRoutingTime,
  reportFirstResponse,
  reportResolutionTime,
  reportAiAccuracy,
  reportAiAcceptance,
  reportRecurringCategories,
  reportDailyIntake,
  reportAiAccuracyByModel,
  reportAiAcceptanceByModel,
  reportAiConfusion,
} = reportQueries;
