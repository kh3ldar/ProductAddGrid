/**
 * Error handling utilities for the ProductAddGrid PCF control
 * Provides standardized error extraction and type guards for Dataverse Web API errors
 */

import { WebApiError } from '../types';
import { LoggerService } from '../services/LoggerService';

/**
 * Type guard to check if an error is a Dataverse Web API error
 * @param error - Unknown error object
 * @returns True if error matches WebApiError structure
 */
export function isWebApiError(error: unknown): error is WebApiError {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  
  const err = error as Record<string, unknown>;
  return (
    typeof err.message === 'string' ||
    (typeof err.raw === 'object' && err.raw !== null && typeof (err.raw as Record<string, unknown>).message === 'string') ||
    typeof err.code === 'number'
  );
}

/**
 * Extract error message from various error formats
 * Handles Dataverse Web API errors, Error objects, and unknown error types
 * 
 * @param error - Error object (unknown type for maximum flexibility)
 * @returns Human-readable error message
 * 
 * @example
 * extractErrorMessage(new Error('Test')) // returns 'Test'
 * extractErrorMessage({ message: 'API Error' }) // returns 'API Error'
 * extractErrorMessage({ raw: { message: 'Inner error' } }) // returns 'Inner error'
 */
export function extractErrorMessage(error: unknown): string {
  // Handle null/undefined
  if (error == null) {
    return 'Unknown error occurred';
  }

  // Handle string errors
  if (typeof error === 'string') {
    return error;
  }

  // Handle Error objects
  if (error instanceof Error) {
    return error.message;
  }

  // Handle Web API error structure
  if (isWebApiError(error)) {
    // Try direct message
    if (error.message) {
      return error.message;
    }
    
    // Try nested raw.message
    if (error.raw?.message) {
      return error.raw.message;
    }
    
    // Try code
    if (error.code !== undefined) {
      return `Error code: ${error.code}`;
    }
  }

  // Handle generic objects with message property
  if (typeof error === 'object') {
    const err = error as Record<string, unknown>;
    if (typeof err.message === 'string') {
      return err.message;
    }
  }

  // Fallback: stringify the error
  try {
    return JSON.stringify(error);
  } catch {
    return error instanceof Error ? error.message : `[error: ${typeof error}]`;
  }
}

/**
 * Check if an error message indicates a missing field error
 * Common in Dataverse when querying fields that don't exist on an entity
 * 
 * @param error - Error object
 * @returns True if error indicates a missing/invalid field
 */
export function isMissingFieldError(error: unknown): boolean {
  const message = extractErrorMessage(error).toLowerCase();
  return (
    message.includes('could not find a property') ||
    message.includes('does not exist') ||
    message.includes('invalid field') ||
    message.includes('not found')
  );
}

/**
 * Check if an error indicates the custom-page auth handshake wasn't ready yet.
 * PCF init/mount can race the host session's auth setup in a freshly opened dialog,
 * surfacing as "no user is logged in" or a 401 on the very first Web API call.
 *
 * @param error - Error object
 * @returns True if error looks like an auth-not-ready race rather than a real failure
 */
export function isAuthNotReadyError(error: unknown): boolean {
  const message = extractErrorMessage(error).toLowerCase();
  return (
    message.includes('no user is logged in') ||
    message.includes('not signed in') ||
    message.includes('not logged in') ||
    message.includes('401') ||
    message.includes('unauthorized')
  );
}

/**
 * Wrap context.webAPI so calls made during the mount-time auth handshake race (custom-page
 * session still settling in a freshly opened dialog) transparently retry once after a short
 * delay. Applied once at webAPI's single construction point so no individual call site needs
 * its own retry logic.
 *
 * The retry only applies within `graceMs` of wrapping — this is specifically the mount race
 * mitigation, not a general-purpose retry. An auth error on a save clicked minutes later is a
 * real failure (e.g. an expired session) and should surface immediately, not be silently
 * delayed.
 */
export function withAuthRetry(webApi: ComponentFramework.WebApi, graceMs = 5000): ComponentFramework.WebApi {
  const graceUntil = Date.now() + graceMs;
  return new Proxy(webApi, {
    get(target, prop, receiver): unknown {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') {
        return value;
      }
      return async (...args: unknown[]): Promise<unknown> => {
        try {
          return await (value as (...a: unknown[]) => unknown).apply(target, args);
        } catch (error) {
          if (Date.now() > graceUntil || !isAuthNotReadyError(error)) {
            throw error;
          }
          LoggerService.warn(`webAPI.${String(prop)} hit an auth-not-ready error, retrying once:`, error);
          await new Promise(resolve => setTimeout(resolve, 750));
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        }
      };
    }
  });
}
