import { timingSafeEqual } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { APP_CONFIG, AppConfig } from '../config';

/**
 * Minimal local-development operator protection: a shared token in `x-admin-token` (or a
 * Bearer header). NOT production authentication; it exists so the retry action is enforced on
 * the backend, not just hidden in the UI. With no ADMIN_TOKEN configured, admin access is denied.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.adminToken;
    if (!expected)
      throw new UnauthorizedException('operator access is disabled (ADMIN_TOKEN not set)');

    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers['x-admin-token'];
    const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, '');
    const provided = (Array.isArray(header) ? header[0] : header) ?? bearer ?? '';

    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('a valid operator token is required');
    }
    return true;
  }
}
