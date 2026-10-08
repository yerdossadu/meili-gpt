import unittest,runpy,tempfile,json
from pathlib import Path
import cv2,numpy as np
build=runpy.run_path(str(Path(__file__).with_name('css-rebuild.py')))['build']

class ReconstructionTests(unittest.TestCase):
    def test_real_text_without_source_image_background(self):
        root=Path(__file__).resolve().parents[2]/'.local'
        with tempfile.TemporaryDirectory(dir=root) as directory:
            p=Path(directory)
            cv2.imwrite(str(p/'scan.png'),np.full((200,200,3),255,np.uint8))
            (p/'raw.json').write_text(json.dumps({'parsing_res_list':[{'block_label':'text','block_bbox':[20,20,180,80]},{'block_label':'image','block_bbox':[20,100,180,180]}]}))
            (p/'ocr.json').write_text(json.dumps({'lines':[{'text':'<script>','position':{'x':.1,'y':.1,'width':.5,'height':.1}}]}))
            build(p/'scan.png',p/'raw.json',p/'ocr.json',p,7)
            html=(p/'7.html').read_text(encoding='utf-8')
            self.assertIn('&lt;script&gt;',html)
            self.assertNotIn('src="7.png"',html)
            self.assertIn('src="assets/p7-image1-card1.png"',html)
            self.assertEqual(html.count('class="glyph"'),1)

    def test_decoration_keeps_large_cutout_as_vector(self):
        root=Path(__file__).resolve().parents[2]/'.local'
        with tempfile.TemporaryDirectory(dir=root) as directory:
            p=Path(directory);image=np.full((500,500,3),255,np.uint8)
            cv2.rectangle(image,(20,20),(480,180),(30,50,210),-1)
            cv2.rectangle(image,(30,30),(180,150),(255,255,255),-1)
            cv2.imwrite(str(p/'scan.png'),image)
            (p/'raw.json').write_text(json.dumps({'parsing_res_list':[]}))
            (p/'ocr.json').write_text(json.dumps({'lines':[]}))
            build(p/'scan.png',p/'raw.json',p/'ocr.json',p,1)
            output=(p/'1.html').read_text(encoding='utf-8')
            self.assertIn('fill-rule="evenodd"',output)
            self.assertGreaterEqual(output.count(' Z'),2)
            self.assertNotIn('src="1.png"',output)

    def test_four_frames_are_detected_without_fixed_coordinates(self):
        detect=runpy.run_path(str(Path(__file__).with_name('css-rebuild.py')))['framed_regions']
        image=np.full((200,800,3),255,np.uint8)
        for x in [10,210,410,610]:cv2.rectangle(image,(x,10),(x+175,190),(180,180,210),2)
        boxes=detect(image,[0,0,800,200])
        self.assertEqual(len(boxes),4)
        self.assertTrue(all(boxes[i][2]<boxes[i+1][0] for i in range(3)))

    def test_header_texture_is_not_a_vertical_rule(self):
        detect=runpy.run_path(str(Path(__file__).with_name('css-rebuild.py')))['vertical_rules']
        ink=np.zeros((300,600),np.uint8);ink[:80,:]=255
        for x in (5,180,590):ink[:,x:x+3]=255
        ink[:90,100:105]=255
        self.assertEqual(detect(ink),[(5,8),(180,183),(590,593)])

if __name__=='__main__':unittest.main()
