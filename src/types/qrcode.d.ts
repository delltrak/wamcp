declare module "qrcode" {
  export interface QrSvgOptions {
    type: "svg";
    errorCorrectionLevel?: "L" | "M" | "Q" | "H";
    margin?: number;
  }

  export function toString(text: string, options: QrSvgOptions): Promise<string>;

  const qrcode: {
    toString: typeof toString;
  };

  export default qrcode;
}
