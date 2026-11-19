/**
 * `accounts` schema (T-07, Tech Spec §2.3 / §2.5).
 *
 * Password hashing and login behavior belong to T-10; this schema only stores
 * the bcrypt hash produced by the auth layer.
 */

import mongoose, { type HydratedDocument, type Model, type Types } from 'mongoose';

export interface AccountDocument {
  _id: Types.ObjectId;
  email: string;
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt?: Date;
}

const accountSchema = new mongoose.Schema<AccountDocument>(
  {
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    passwordHash: { type: String, required: true },
    lastLoginAt: { type: Date },
  },
  {
    collection: 'accounts',
    versionKey: false,
    timestamps: true,
  },
);

accountSchema.index({ email: 1 }, { unique: true });

export type AccountHydratedDocument = HydratedDocument<AccountDocument>;

export const AccountModel: Model<AccountDocument> =
  (mongoose.models.Account as Model<AccountDocument> | undefined) ??
  mongoose.model<AccountDocument>('Account', accountSchema);
