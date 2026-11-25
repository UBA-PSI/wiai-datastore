import unittest

from wds_server import util


def seq(n, s=0):
    return bytes((s + i) % 256 for i in range(n))


class Encodings(unittest.TestCase):
    def test_b32c_vectors(self):
        self.assertEqual(util.b32c_encode(seq(12)), "000G40R40M30E209185Z")
        self.assertEqual(util.b32c_encode(seq(17, 0x20)), "40GJ48S44MK2EA1958NJRB9E5WR8")
        self.assertEqual(util.b32c_decode("000G40R40M30E209185Z", 12), seq(12))

    def test_b32c_rejects_bad_check_bits_and_symbols(self):
        with self.assertRaises(ValueError):
            util.b32c_decode("000G40R40M30E209185Y", 12)
        with self.assertRaises(ValueError):
            util.b32c_decode("000G40R40M30E209185U", 12)
        with self.assertRaises(ValueError):
            util.b32c_decode("000g40R40M30E209185Z", 12)
        with self.assertRaises(ValueError):
            util.b32c_decode("000G40R40M30E209185", 12)

    def test_b32c_roundtrip(self):
        import os
        for n in (12, 17):
            for _ in range(50):
                data = os.urandom(n)
                self.assertEqual(util.b32c_decode(util.b32c_encode(data), n), data)

    def test_vault_id_vector(self):
        self.assertEqual(util.vault_id_from_pub(seq(65)), "9FYJS2VF3VP7MAQYPJ5S6KQ4P9")

    def test_padme_table(self):
        table = {1: 1, 3: 3, 9: 10, 40: 40, 100: 104, 1000: 1024, 1025: 1088, 4097: 4352, 65537: 67584,
                 1048577: 1081344, 10487812: 10747904}
        for length, expected in table.items():
            self.assertEqual(util.padme(length), expected, length)

    def test_b64u_strict(self):
        self.assertEqual(util.b64u_decode("AAEC"), b"\x00\x01\x02")
        for bad in ("AAEC=", "AA+C", "AB", "A", "AAEC\n", "AAF"):
            with self.assertRaises(ValueError, msg=bad):
                util.b64u_decode(bad)
        with self.assertRaises(ValueError):
            util.b64u_decode("AAEC", 4)

    def test_cjson(self):
        self.assertEqual(util.cjson({"b": [1, True, None], "a": "x"}), b'{"a":"x","b":[1,true,null]}')
        for bad in (1.5, "a\"b", "ä", -1, 2**53, {"a": 1.0}, "a\\b"):
            with self.assertRaises(ValueError, msg=repr(bad)):
                util.cjson(bad)
        self.assertEqual(util.cjson(2**53 - 1), b"9007199254740991")

    def test_strict_json(self):
        with self.assertRaises(ValueError):
            util.loads_strict('{"a":1,"a":2}')
        with self.assertRaises(ValueError):
            util.loads_strict('{"a":1.5}')
        with self.assertRaises(ValueError):
            util.loads_strict("NaN")
        with self.assertRaises(ValueError):
            util.loads_strict(b"\xff")
        self.assertEqual(util.loads_strict('{"a":[1,2]}'), {"a": [1, 2]})

    def test_max_envelope(self):
        self.assertEqual(util.max_envelope_bytes(10485760), util.padme(4 + 2048 + 10485760) + 38)


if __name__ == "__main__":
    unittest.main()
