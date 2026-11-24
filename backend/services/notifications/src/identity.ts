import { NOTIFICATION_IDENTITY, notificationRecipientSchema } from '@smartdesk/contracts';
import { createDelegatedIdentityResolver } from '@smartdesk/service-runtime/delegated-identity';
export { ServiceRequestError as InboxRequestError } from '@smartdesk/service-runtime/delegated-identity';

export function createRecipientResolver(config: {
  identityOrigin: URL;
  keyId: string;
  privateKey: string;
}) {
  return createDelegatedIdentityResolver({
    ...config,
    keySetting: 'NOTIFICATIONS_PRIVATE_KEY',
    service: 'notifications',
    route: NOTIFICATION_IDENTITY,
    decode: (body) => notificationRecipientSchema.parse(body).recipientId,
  });
}
