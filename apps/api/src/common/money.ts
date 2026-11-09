import { applyDecorators } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { Matches, Validate, ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';
import { Prisma } from '@prisma/client';

/** Money travels as a decimal STRING over the wire (never a JS float) and is stored as Decimal(19,4). */
export const MONEY_REGEX = /^\d{1,15}(\.\d{1,4})?$/;
export const CURRENCY_REGEX = /^[A-Z]{3}$/;

@ValidatorConstraint({ name: 'positiveMoney', async: false })
class PositiveMoney implements ValidatorConstraintInterface {
  validate(v: unknown) {
    return typeof v === 'string' && MONEY_REGEX.test(v) && new Prisma.Decimal(v).gt(0);
  }
  defaultMessage() {
    return 'must be a positive decimal string with at most 4 decimal places (e.g. "125.50")';
  }
}

export const IsMoney = () =>
  applyDecorators(ApiProperty({ type: String, example: '125.50' }), Validate(PositiveMoney));

export const IsCurrency = () =>
  applyDecorators(ApiProperty({ example: 'EUR' }), Matches(CURRENCY_REGEX, { message: 'currency must be a 3-letter upper-case ISO code' }));
