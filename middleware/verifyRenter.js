/**
 * "Renter" is the assignment terminology for the customer database role.
 * Must run after verifyToken so req.user contains verified token claims.
 */
export function verifyRenter(req, res, next) {
  if (req.user?.role !== "customer") {
    return res.status(403).send({ message: "Customer access required" })
  }

  return next()
}