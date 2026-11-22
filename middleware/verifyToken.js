import { jwtVerify } from "jose"

/**
 * Verifies the HS256 access token issued by the Next.js server from a verified
 * Better Auth session. The user identity attached to req.user comes only from
 * the signed token — never from request bodies, query strings or headers.
 */
export async function verifyToken(req, res, next) {
  try {
    const header = req.get("authorization") || ""
    const parts = header.split(" ")

    if (parts.length !== 2 || !/^Bearer$/i.test(parts[0]) || !parts[1]) {
      return res.status(401).send({ message: "Authentication required" })
    }

    const secret = process.env.JWT_SECRET

    if (!secret) {
      console.error("JWT_SECRET is not configured")
      return res.status(500).send({ message: "Authentication is not configured" })
    }

    const { payload } = await jwtVerify(
      parts[1],
      new TextEncoder().encode(secret),
      {
        algorithms: ["HS256"],
        issuer: "easyrent",
        audience: "easyrent-server",
      }
    )

    const role = String(payload.role || "").toLowerCase()

    if (!["customer", "owner", "admin"].includes(role)) {
      return res.status(403).send({ message: "Invalid account role" })
    }

    req.user = {
      id: String(payload.id || payload.sub || ""),
      email: String(payload.email || "").trim().toLowerCase(),
      role,
    }

    return next()
  } catch (error) {
    // jose throws for expired, malformed and wrongly-signed tokens alike.
    return res.status(401).send({ message: "Invalid or expired token" })
  }
}
