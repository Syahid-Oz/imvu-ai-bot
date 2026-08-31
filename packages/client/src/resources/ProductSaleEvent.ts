import { Resource, Product, User } from '../resources';
import { JsonObject, JsonProperty } from 'typescript-json-serializer';

/**
 * Converts a value to an ISO date string for the serializer to parse.
 * The typescript-json-serializer library's deserializePrimitive for 'date' type
 * expects a string that can be parsed with Date.parse(), NOT a Date object.
 * 
 * Handles ISO strings, Date objects, and Unix timestamps (numbers in seconds or milliseconds).
 */
function toDate(value: unknown): string | null {
	if (value instanceof Date) {
		return value.toISOString();
	}
	if (typeof value === 'string') {
		const date = new Date(value);
		return isNaN(date.getTime()) ? value : date.toISOString();
	}
	if (typeof value === 'number') {
		// Unix timestamp in seconds is typically ~10 digits (e.g. 1700000000)
		// Unix timestamp in milliseconds is typically ~13 digits (e.g. 1700000000000)
		// If the number is less than 1e12 (year 2286 in ms), assume it's in seconds
		const date = new Date(value < 1e12 ? value * 1000 : value);
		return isNaN(date.getTime()) ? null : date.toISOString();
	}
	return null;
}

@JsonObject()
export class ProductSaleEvent extends Resource<ProductSaleEventRelations> {
	@JsonProperty({
		name: 'purchased_datetime',
		beforeDeserialize: (value: unknown) => toDate(value),
	})
	public timestamp: Date = new Date();

	@JsonProperty({
		beforeDeserialize: (value: unknown) => toDate(value),
	})
	public incomeAvailableDatetime: Date = new Date();

	@JsonProperty()
	public buyerId = '';

	@JsonProperty()
	public recipientId = '';

	@JsonProperty()
	public productId = '';

	@JsonProperty()
	public productName = '';

	@JsonProperty()
	public transactionId = '';

	public async buyer(): Promise<User | null> {
		return this.relationship('buyer', User);
	}

	public async recipient(): Promise<User | null> {
		return this.relationship('recipient', User);
	}

	public async product(): Promise<Product | null> {
		return this.relationship('product', Product);
	}
}

export interface ProductSaleEventRelations {
	buyer: string;
	recipient: string;
	product: string;
}
