// GRVT Order Signer - EIP-712 Implementation
// Implementación de firma de órdenes según formato verificado por Marta
// ⚠️ CRÍTICO: PRICE_MULTIPLIER = 1e9, NO usar quote_decimals

import { SignTypedDataVersion, signTypedData } from '@metamask/eth-sig-util';
import dotenv from 'dotenv';

dotenv.config();

// Gate every per-order log behind DEBUG_SIGN=1. With 39 bots placing
// orders constantly, the un-gated console.log dump (~25 lines per
// signature + full EIP-712 JSON twice) was the dominant log-volume
// source — ~50 GB/day projected, filling /var/log inside 24h and
// taking grvtbot.com to 502 (2026-06-05, 2026-06-07).
const debugSign = process.env.DEBUG_SIGN === '1';
const dlog = (...args: unknown[]): void => {
  if (debugSign) console.log(...args);
};

// EIP-712 Domain para GRVT Exchange
const EIP712_DOMAIN = {
  name: 'GRVT Exchange',
  version: '0',
  chainId: 325, // GRVT Production chainId
};

// EIP-712 Types para Order
const EIP712_TYPES = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
  ],
  Order: [
    { name: 'subAccountID', type: 'uint64' },
    { name: 'isMarket', type: 'bool' },
    { name: 'timeInForce', type: 'uint8' },
    { name: 'postOnly', type: 'bool' },
    { name: 'reduceOnly', type: 'bool' },
    { name: 'legs', type: 'OrderLeg[]' },
    { name: 'nonce', type: 'uint32' },
    { name: 'expiration', type: 'int64' },
  ],
  OrderLeg: [
    { name: 'assetID', type: 'uint256' },
    { name: 'contractSize', type: 'uint64' },
    { name: 'limitPrice', type: 'uint64' },
    { name: 'isBuyingContract', type: 'bool' },
  ],
};

// ⚠️ CRÍTICO: PRICE_MULTIPLIER = 1e9 (verificado por Marta)
const PRICE_MULTIPLIER = 1e9;

// Legacy fallback — only consulted if the dynamic cache from client.ts
// (populated by getInstruments()) doesn't have the instrument yet.
import { getInstrumentSpec } from './client.js';

const FALLBACK_INSTRUMENT_TO_ASSET_ID: Record<string, string> = {
  'ETH_USDT_Perp': '0x030401',
  'BTC_USDT_Perp': '0x030501',
};

const FALLBACK_BASE_DECIMALS: Record<string, number> = {
  'ETH_USDT_Perp': 9,
  'BTC_USDT_Perp': 9,
};

function getAssetId(instrument: string): string | undefined {
  const spec = getInstrumentSpec(instrument);
  return spec.instrument_hash ?? FALLBACK_INSTRUMENT_TO_ASSET_ID[instrument];
}

function getBaseDecimals(instrument: string): number {
  const spec = getInstrumentSpec(instrument);
  return spec.base_decimals ?? FALLBACK_BASE_DECIMALS[instrument] ?? 9;
}

/**
 * Generar nonce aleatorio uint32
 */
function generateNonce(): number {
  return Math.floor(Math.random() * 1e9);
}

/**
 * Generar timestamp de expiración en nanosegundos
 * @param hours Horas hasta la expiración (default: 24h)
 */
function generateExpiration(hours: number = 24): string {
  const milliseconds = Date.now() + hours * 3600000;
  return (milliseconds * 1e6).toString(); // Convertir a nanosegundos
}

// ⚠️ Función assetIdToUint256 removida - ya no se necesita

/**
 * Convertir size a contract size en base units
 * ⚠️ ACTUALIZADO: usar base_decimals del instrumento
 */
function sizeToContractSize(size: string, instrument: string): string {
  // Round to min_size before computing contractSize
  const spec = getInstrumentSpec(instrument);
  const minSize = spec.min_size;
  const sizeNum = Math.floor(parseFloat(size) / minSize) * minSize;
  const baseDecimals = getBaseDecimals(instrument);
  const contractSize = Math.round(sizeNum * Math.pow(10, baseDecimals));
  return contractSize.toString();
}

/**
 * Convertir price a limit price
 * ⚠️ CRÍTICO: SIEMPRE usar PRICE_MULTIPLIER = 1e9 (no quote_decimals)
 */
function roundToTickSize(price: number, tickSize: number = 0.01): number {
  return Math.floor(price / tickSize) * tickSize;
}

function priceToLimitPrice(price: string, tickSize: number = 0.01): string {
  const priceNum = roundToTickSize(parseFloat(price), tickSize);
  const limitPrice = Math.round(priceNum * PRICE_MULTIPLIER);
  return limitPrice.toString();
}

// Also export a helper to round prices for the API payload
export function roundPrice(price: string | number, tickSize: number = 0.01): string {
  const p = typeof price === 'string' ? parseFloat(price) : price;
  return roundToTickSize(p, tickSize).toString();
}

/**
 * Crear orden EIP-712 para firmar
 */
export interface OrderParams {
  instrument: string;
  side: 'buy' | 'sell';
  size: string;
  price?: string; // Opcional para market orders
  isMarket?: boolean; // Nuevo: para market orders
  timeInForce?: number; // Nuevo: 1=GTC, 3=IOC
  postOnly?: boolean; // true = maker only, orden se cancela si haría taker
  leverage?: number; // No usado directamente en la firma, pero útil para logging
}

export interface SignedOrder {
  subAccountID: string;
  isMarket: boolean;
  timeInForce: number;
  postOnly: boolean;
  reduceOnly: boolean;
  legs: Array<{
    assetID: string;
    contractSize: string;
    limitPrice: string;
    isBuyingContract: boolean;
  }>;
  nonce: number;
  expiration: string;
  signature: {
    signer: string;
    r: string;
    s: string;
    v: number;
    expiration: string;
    nonce: number;
  };
}

/**
 * Firmar orden usando EIP-712
 */
/**
 * Optional explicit signing credentials. When provided, signOrder
 * uses these instead of reading from environment variables. This is
 * the multi-tenant path: each GRVTClient passes its own creds.
 */
export interface SigningCreds {
  privateKey: string;      // hex private key (0x...)
  signerAddress: string;   // Ethereum address (0x...)
  subAccountId: string;    // GRVT sub_account_id
}

export async function signOrder(
  params: OrderParams,
  signingCreds?: SigningCreds
): Promise<SignedOrder> {
  const { instrument, side, size, price, isMarket = false, timeInForce = 1, postOnly: postOnlyParam = false } = params;

  // Validar que tengamos configuración para el instrumento (dinámica via getInstrumentSpec)
  const assetIdCheck = getAssetId(instrument);
  if (!assetIdCheck) {
    throw new Error(`Instrumento no soportado (no instrument_hash en cache): ${instrument}. Reinicia el bot o llama getInstruments() primero.`);
  }

  // Para market orders, price es opcional
  if (!isMarket && !price) {
    throw new Error('Precio requerido para órdenes limit');
  }

  // Multi-tenant: use explicit creds if provided, else fall back to env.
  const privateKey = signingCreds?.privateKey ?? process.env.GRVT_API_SECRET;
  const signerAddress = signingCreds?.signerAddress ?? process.env.GRVT_TRADING_ADDRESS;
  const subAccountID = signingCreds?.subAccountId ?? process.env.GRVT_TRADING_ACCOUNT_ID;

  if (!privateKey || !signerAddress || !subAccountID) {
    throw new Error('Credenciales faltantes: GRVT_API_SECRET, GRVT_TRADING_ADDRESS, GRVT_TRADING_ACCOUNT_ID');
  }

  // Generar nonce y expiration
  const nonce = generateNonce();
  const expiration = generateExpiration(24); // 24 horas

  // Convertir parámetros a formato EIP-712 (formato verificado por Marta)
  const assetID = getAssetId(instrument)!; // checked above
  const contractSize = sizeToContractSize(size, instrument);
  
  // Para market orders, usar price actual o 0 (será ignorado por el exchange)
  const limitPrice = isMarket ? '0' : priceToLimitPrice(price!);
  const isBuyingContract = side === 'buy';

  // Crear orden para firmar
  const orderMessage = {
    subAccountID: subAccountID,
    isMarket: isMarket,
    timeInForce: timeInForce, // 1=GTC, 3=IOC
    postOnly: postOnlyParam,
    reduceOnly: false,
    legs: [
      {
        assetID,
        contractSize,
        limitPrice,
        isBuyingContract,
      },
    ],
    nonce,
    expiration,
  };

  // Crear estructura EIP-712 completa
  const typedData = {
    primaryType: 'Order' as const,
    domain: EIP712_DOMAIN,
    types: EIP712_TYPES,
    message: orderMessage,
  };

  dlog('🔏 Firmando orden EIP-712:');
  dlog(`  Instrumento: ${instrument} (assetID: ${assetID})`);
  dlog(`  Lado: ${side} (isBuyingContract: ${isBuyingContract})`);
  dlog(`  Tipo: ${isMarket ? 'MARKET' : 'LIMIT'}`);
  dlog(`  Size: ${size} → contractSize: ${contractSize}`);
  dlog(`  Price: ${price || 'N/A'} → limitPrice: ${limitPrice}`);
  dlog(`  TimeInForce: ${timeInForce} (${timeInForce === 1 ? 'GTC' : timeInForce === 3 ? 'IOC' : 'OTHER'})`);
  dlog(`  Nonce: ${nonce}`);
  dlog(`  Expiration: ${expiration}`);

  dlog('\n📋 EIP-712 message completo:');
  dlog(JSON.stringify(orderMessage, null, 2));

  dlog('\n🏢 EIP-712 domain:');
  dlog(JSON.stringify(EIP712_DOMAIN, null, 2));

  try {
    // Firmar usando @metamask/eth-sig-util
    const signature = signTypedData({
      privateKey: Buffer.from(privateKey.replace(/^0x/, ''), 'hex'),
      data: typedData,
      version: SignTypedDataVersion.V4,
    });

    dlog(`  Signature: ${signature}`);

    // Decodificar signature en r, s, v
    const r = '0x' + signature.slice(2, 66);
    const s = '0x' + signature.slice(66, 130);
    const v = parseInt(signature.slice(130, 132), 16);

    dlog(`  r: ${r}`);
    dlog(`  s: ${s}`);
    dlog(`  v: ${v}`);

    // Retornar orden firmada
    const signedOrder: SignedOrder = {
      ...orderMessage,
      signature: {
        signer: signerAddress,
        r,
        s,
        v,
        expiration,
        nonce,
      },
    };

    dlog('✅ Orden firmada exitosamente');
    return signedOrder;

  } catch (error) {
    console.error('❌ Error firmando orden:', error);
    throw new Error(`Falló firma EIP-712: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Convertir orden firmada al formato de API de GRVT
 * ⚠️ ACTUALIZADO: formato verificado por Marta para endpoint /full/v1/create_order
 */
export function formatSignedOrderForAPI(signedOrder: SignedOrder, instrument: string, size: string, price: string | undefined, side: 'buy' | 'sell'): any {
  const leg = signedOrder.legs[0];
  if (!leg) {
    throw new Error('SignedOrder must have at least one leg');
  }
  
  // Generate unique client_order_id
  const clientOrderId = String(Date.now());

  // Determinar time_in_force string según timeInForce numérico
  let timeInForceString: string;
  switch (signedOrder.timeInForce) {
    case 3:
      timeInForceString = 'IMMEDIATE_OR_CANCEL';
      break;
    case 1:
    default:
      timeInForceString = 'GOOD_TILL_TIME';
      break;
  }
  
  // ⚠️ FORMATO ACTUALIZADO: El API acepta valores human-readable
  const orderRequest = {
    order: {
      sub_account_id: signedOrder.subAccountID,
      is_market: signedOrder.isMarket,
      time_in_force: timeInForceString,
      post_only: signedOrder.postOnly,
      reduce_only: signedOrder.reduceOnly,
      legs: [
        {
          instrument: instrument, // ⚠️ CAMBIO: human-readable name
          size: roundPrice(size, 0.01), // ⚠️ Rounded to min_size
          limit_price: signedOrder.isMarket ? undefined : roundPrice(price!), // ⚠️ Rounded to tick_size
          is_buying_asset: leg.isBuyingContract, // ⚠️ CAMBIO: is_buying_asset
        },
      ],
      signature: {
        signer: signedOrder.signature.signer,
        r: signedOrder.signature.r,
        s: signedOrder.signature.s,
        v: signedOrder.signature.v,
        expiration: signedOrder.signature.expiration, // SAME as in signed message
        nonce: signedOrder.signature.nonce, // SAME as in signed message
      },
      metadata: {
        client_order_id: clientOrderId // ⚠️ OBLIGATORIO
      }
    },
  };
  
  dlog('📦 Request JSON que se enviará a GRVT (/full/v1/create_order):');
  dlog(JSON.stringify(orderRequest, null, 2));
  
  return orderRequest;
}

export default {
  signOrder,
  formatSignedOrderForAPI,
};