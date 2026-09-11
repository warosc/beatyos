import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import { GoalMetric } from '@prisma/client';

import { PaginationQueryDto } from '../../../../shared/infrastructure/http/dto/pagination.dto';

export class CreateGoalDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  stylistId!: string;

  @ApiProperty({ enum: GoalMetric })
  @IsEnum(GoalMetric)
  metric!: GoalMetric;

  @ApiProperty({ example: 2000, description: 'Objetivo de facturación, en la moneda del salón' })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  targetAmount!: number;

  @ApiProperty({ format: 'date-time', example: '2026-09-01T00:00:00.000Z' })
  @IsISO8601()
  periodStart!: string;

  @ApiProperty({ format: 'date-time', example: '2026-09-30T23:59:59.000Z' })
  @IsISO8601()
  periodEnd!: string;

  @ApiProperty({ example: 'Gift card Q200 Walmart' })
  @IsString()
  @MaxLength(250)
  rewardDescription!: string;
}

export class GoalQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Solo con `goals.read`: filtra por profesional. Con `goals.read.own` se ignora.',
  })
  @IsOptional()
  @IsUUID()
  stylistId?: string;

  @ApiPropertyOptional({ enum: GoalMetric })
  @IsOptional()
  @IsEnum(GoalMetric)
  metric?: GoalMetric;
}

export class GoalResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ format: 'uuid' }) stylistId!: string;
  @ApiProperty({ enum: GoalMetric }) metric!: string;
  @ApiProperty() targetAmount!: string;
  @ApiProperty() progress!: string;
  @ApiProperty({ description: '0-100, recortado al 100 aunque se haya superado' })
  percentage!: number;
  @ApiProperty() currency!: string;
  @ApiProperty({ format: 'date-time' }) periodStart!: string;
  @ApiProperty({ format: 'date-time' }) periodEnd!: string;
  @ApiProperty() rewardDescription!: string;
  @ApiProperty({ enum: ['ACTIVE', 'ACHIEVED', 'EXPIRED'] }) status!: string;
  @ApiProperty({ nullable: true, format: 'date-time' }) achievedAt!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}
