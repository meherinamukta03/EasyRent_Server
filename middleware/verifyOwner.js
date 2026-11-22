/** Must run after verifyToken. */
export function verifyOwner(req, res, next) {
  if (req.user?.role !== "owner") {
    return res.status(403).send({ message: "Owner access required" })
  }

  return next()
}
