import runpy
import unittest
from pathlib import Path
import numpy as np

module=runpy.run_path(str(Path(__file__).with_name('refine-runner.py')),run_name='test_import')
split=module['split_region']

class RegionTests(unittest.TestCase):
    def test_pinyin_stays_whole_and_hanzi_are_individual(self):
        tokens=list(module['aligned_tokens']('cài菜好',[20,[['c'],['à'],['i'],['菜','好']],[[1],[4],[7],[12,17]],[]],[100,200,300,240]))
        self.assertEqual([t[0] for t in tokens],['cài','菜','好'])
        self.assertTrue(all(100<=b[0]<b[2]<=300 for _,b in tokens))
    def test_invalid_batch_alignment_is_rejected(self):
        with self.assertRaises(ValueError):list(module['aligned_tokens']('菜',[2,[['菜']],[[12]],[]],[0,0,100,100]))
    def test_stacked_labels_are_separated_and_coordinates_serializable(self):
        import json
        image=np.full((100,100,3),255,np.uint8)
        image[10:40,20:80]=0;image[60:90,20:80]=0
        boxes=split(image,[0,0,100,100],'à菜')
        self.assertEqual(len(boxes),2)
        json.dumps(boxes)
        self.assertLessEqual(boxes[0][3],boxes[1][1])
    def test_small_detached_tone_is_kept_with_its_letter(self):
        image=np.full((100,100,3),255,np.uint8)
        image[5:10,40:60]=0;image[30:90,20:80]=0
        self.assertEqual(split(image,[0,0,100,100],'ā'),[(0,0,100,100)])

if __name__=='__main__':unittest.main()
