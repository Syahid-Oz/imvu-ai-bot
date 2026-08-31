import { JsonObject, JsonProperty } from 'typescript-json-serializer';

import { GetMatched, Product, ProfileUser, Room } from './index';

import { Resource } from './Resource';
import { Creator } from './Creator';

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
export class User extends Resource<UserRelations> {
	@JsonProperty({
		beforeDeserialize: (value: unknown) => toDate(value),
	})
	public created: Date = new Date();

	@JsonProperty({
		beforeDeserialize: (value: unknown) => toDate(value),
	})
	public registered: Date = new Date();

	@JsonProperty()
	public gender?: string; // TODO: Add interface/class

	@JsonProperty()
	public displayName = '';

	@JsonProperty()
	public age?: number;

	@JsonProperty()
	public country = '';

	@JsonProperty()
	public state?: string;

	@JsonProperty()
	public avatarImage = '';

	@JsonProperty()
	public avatarPortraitImage = '';

	@JsonProperty()
	public username = '';

	@JsonProperty()
	public isVip = false;

	@JsonProperty()
	public isAp = false;

	@JsonProperty()
	public isCreator = false;

	@JsonProperty()
	public isAdult = false;

	@JsonProperty('is_ageverified')
	public isAgeVerified = false;

	@JsonProperty()
	public isStaff = false;

	public async *wishlist(): AsyncIterableIterator<Product> {
		yield* this.paginatedRelationship('wishlist', Product);
	}

	public async profile(): Promise<ProfileUser | null> {
		return this.relationship('profile', ProfileUser);
	}

	public async creator(): Promise<Creator | null> {
		return this.relationship('creator_details', Creator);
	}

	public async spouse(): Promise<User | null> {
		return this.relationship('spouse', User);
	}

	public async matched(): Promise<GetMatched | null> {
		return this.relationship('get_matched_profile', GetMatched);
	}

	public async current_room(): Promise<Room | null> {
		return this.relationship('current_room', Room);
	}

	public async gift(product: number | string | Product, message = ''): Promise<boolean> {
		return this.client.account.gifts.gift(this, product, message);
	}

	/**
	 * A convenience method for sending a friend request to this user.
	 * @see {@link FriendManager#add}
	 * @return {Promise<boolean>}
	 */
	public async add(): Promise<boolean> {
		return this.client.account.friends.add(this);
	}

	/**
	 * A convenience method for removing a user from your friends list.
	 * @see {@link FriendManager#remove}
	 * @return {Promise<boolean>}
	 */
	public async remove(): Promise<boolean> {
		return this.client.account.friends.remove(this);
	}
}

export interface UserRelations {
	profile: string;
	wishlist: string;
	creator_details: string;
	spouse: string;
	get_matched_profile: string;
	current_room: string;
}
