import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNumber,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class CheckItemDto {
  @IsString()
  @Length(1, 200)
  name!: string;

  @IsInt()
  @Min(1)
  @Max(1000)
  quantity!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  @Min(0)
  unitPrice!: number;
}

export class CreateCheckDto {
  @IsString()
  @Length(1, 64)
  restaurantId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CheckItemDto)
  items!: CheckItemDto[];

  /**
   * Deliberately not required to be positive: the POS owns that rule and answers 422, which is
   * the permanent-rejection path the sync must surface (see DECISIONS.md, assumptions).
   */
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
  @Min(-1_000_000)
  @Max(1_000_000)
  total!: number;
}
